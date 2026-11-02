use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod errors;
pub mod events;
pub mod state;

use errors::LaunchError;
use events::*;
use state::*;

declare_id!("CH1MP11111111111111111111111111111111111111");

#[program]
pub mod chimp_fair_launch {
    use super::*;

    pub fn initialize_launch(
        ctx: Context<InitializeLaunch>,
        launch_id: u64,
        total_tokens_allocated: u64,
        start_slot: u64,
        end_slot: u64,
        min_deposit_lamports: u64,
        max_deposit_lamports: u64,
        soft_cap_lamports: u64,
        hard_cap_lamports: u64,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        require!(start_slot < end_slot, LaunchError::LaunchEnded);
        require!(min_deposit_lamports > 0, LaunchError::BelowMinimumContribution);
        require!(min_deposit_lamports <= max_deposit_lamports, LaunchError::ExceedsIndividualCap);
        require!(soft_cap_lamports <= hard_cap_lamports, LaunchError::MathOverflow);

        let config = &mut ctx.accounts.launch_config;
        config.admin = ctx.accounts.admin.key();
        config.launch_id = launch_id;
        config.chimp_mint = ctx.accounts.chimp_mint.key();
        config.token_escrow = ctx.accounts.token_escrow.key();
        config.sol_vault = ctx.accounts.sol_vault.key();
        config.total_tokens_allocated = total_tokens_allocated;
        config.total_lamports_raised = 0;
        config.start_slot = start_slot;
        config.end_slot = end_slot;
        config.min_deposit_lamports = min_deposit_lamports;
        config.max_deposit_lamports = max_deposit_lamports;
        config.soft_cap_lamports = soft_cap_lamports;
        config.hard_cap_lamports = hard_cap_lamports;
        config.merkle_root = merkle_root;
        config.is_finalized = false;
        config.is_soft_cap_reached = false;
        config.liquidity_seeded = false;
        config.bump = ctx.bumps.launch_config;
        config.vault_bump = ctx.bumps.sol_vault;

        // Escrow CHIMP tokens into vault PDA
        let cpi_accounts = Transfer {
            from: ctx.accounts.admin_token_account.to_account_info(),
            to: ctx.accounts.token_escrow.to_account_info(),
            authority: ctx.accounts.admin.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, total_tokens_allocated)?;

        emit!(LaunchInitializedEvent {
            launch_id,
            total_tokens_allocated,
            start_slot,
            end_slot,
            soft_cap_lamports,
            hard_cap_lamports,
        });

        Ok(())
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        amount_lamports: u64,
        proof: Option<Vec<[u8; 32]>>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let current_slot = clock.slot;
        let config = &mut ctx.accounts.launch_config;

        require!(current_slot >= config.start_slot, LaunchError::LaunchNotStarted);
        require!(current_slot <= config.end_slot, LaunchError::LaunchEnded);
        require!(!config.is_finalized, LaunchError::AlreadyFinalized);

        // Optional Merkle Allowlist verification if root is populated
        if config.merkle_root != [0u8; 32] {
            let user_key = ctx.accounts.participant.key().to_bytes();
            let leaf = anchor_lang::solana_program::keccak::hash(&user_key).to_bytes();
            require!(proof.is_some(), LaunchError::InvalidMerkleProof);
            let verified = verify_merkle_proof(proof.unwrap(), config.merkle_root, leaf);
            require!(verified, LaunchError::InvalidMerkleProof);
        }

        let contribution = &mut ctx.accounts.user_contribution;
        let new_user_total = contribution
            .lamports_contributed
            .checked_add(amount_lamports)
            .ok_or(LaunchError::MathOverflow)?;

        require!(
            new_user_total >= config.min_deposit_lamports,
            LaunchError::BelowMinimumContribution
        );
        require!(
            new_user_total <= config.max_deposit_lamports,
            LaunchError::ExceedsIndividualCap
        );

        let new_vault_total = config
            .total_lamports_raised
            .checked_add(amount_lamports)
            .ok_or(LaunchError::MathOverflow)?;

        require!(
            new_vault_total <= config.hard_cap_lamports,
            LaunchError::HardCapExceeded
        );

        // Perform Lamport transfer from user to sol_vault PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.participant.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount_lamports)?;

        // Update state
        contribution.participant = ctx.accounts.participant.key();
        contribution.launch_id = config.launch_id;
        contribution.lamports_contributed = new_user_total;
        contribution.bump = ctx.bumps.user_contribution;

        config.total_lamports_raised = new_vault_total;
        if new_vault_total >= config.soft_cap_lamports {
            config.is_soft_cap_reached = true;
        }

        emit!(DepositEvent {
            launch_id: config.launch_id,
            participant: ctx.accounts.participant.key(),
            lamports_deposited: amount_lamports,
            total_user_deposit: new_user_total,
            total_vault_balance: new_vault_total,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn finalize_launch(ctx: Context<FinalizeLaunch>) -> Result<()> {
        let clock = Clock::get()?;
        let config = &mut ctx.accounts.launch_config;

        require!(clock.slot > config.end_slot, LaunchError::LaunchStillActive);
        require!(!config.is_finalized, LaunchError::AlreadyFinalized);
        require!(config.is_soft_cap_reached, LaunchError::SoftCapNotReached);

        config.is_finalized = true;

        // In a fair launch model: Clearing price = total_lamports_raised / total_tokens_allocated
        let clearing_price = (config.total_lamports_raised as u128)
            .checked_mul(1_000_000_000)
            .ok_or(LaunchError::MathOverflow)?
            .checked_div(config.total_tokens_allocated as u128)
            .ok_or(LaunchError::MathOverflow)? as u64;

        emit!(LaunchFinalizedEvent {
            launch_id: config.launch_id,
            total_lamports_raised: config.total_lamports_raised,
            total_tokens_available: config.total_tokens_allocated,
            final_clearing_price_lamports_per_token: clearing_price,
            pool_seed_lamports: config.total_lamports_raised,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn claim_allocation(ctx: Context<ClaimAllocation>) -> Result<()> {
        let config = &ctx.accounts.launch_config;
        let contribution = &mut ctx.accounts.user_contribution;

        require!(config.is_finalized, LaunchError::NotFinalized);
        require!(!contribution.claimed, LaunchError::AlreadyClaimed);
        require!(contribution.lamports_contributed > 0, LaunchError::ZeroBalance);

        // User allocation: (user_lamports * total_tokens_allocated) / total_lamports_raised
        let token_allocation = (contribution.lamports_contributed as u128)
            .checked_mul(config.total_tokens_allocated as u128)
            .ok_or(LaunchError::MathOverflow)?
            .checked_div(config.total_lamports_raised as u128)
            .ok_or(LaunchError::MathOverflow)? as u64;

        contribution.claimed = true;
        contribution.tokens_claimed = token_allocation;

        let launch_id_bytes = config.launch_id.to_le_bytes();
        let seeds = &[
            b"launch_config".as_ref(),
            launch_id_bytes.as_ref(),
            &[config.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.token_escrow.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.launch_config.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, token_allocation)?;

        emit!(TokensClaimedEvent {
            launch_id: config.launch_id,
            participant: ctx.accounts.participant.key(),
            tokens_claimed: token_allocation,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// Helper: Merkle proof verification using Keccak-256
fn verify_merkle_proof(proof: Vec<[u8; 32]>, root: [u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed_hash = leaf;
    for proof_element in proof.iter() {
        if computed_hash <= *proof_element {
            let mut combined = [0u8; 64];
            combined[..32].copy_from_slice(&computed_hash);
            combined[32..].copy_from_slice(proof_element);
            computed_hash = anchor_lang::solana_program::keccak::hash(&combined).to_bytes();
        } else {
            let mut combined = [0u8; 64];
            combined[..32].copy_from_slice(proof_element);
            combined[32..].copy_from_slice(&computed_hash);
            computed_hash = anchor_lang::solana_program::keccak::hash(&combined).to_bytes();
        }
    }
    computed_hash == root
}

#[derive(Accounts)]
#[instruction(launch_id: u64)]
pub struct InitializeLaunch<'info> {
    #[account(
        init,
        payer = admin,
        space = LaunchConfig::LEN,
        seeds = [b"launch_config", launch_id.to_le_bytes().as_ref()],
        bump
    )]
    pub launch_config: Account<'info, LaunchConfig>,

    #[account(
        init,
        payer = admin,
        seeds = [b"sol_vault", launch_id.to_le_bytes().as_ref()],
        bump,
        space = 0
    )]
    /// CHECK: PDA holding deposited SOL lamports
    pub sol_vault: AccountInfo<'info>,

    pub chimp_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"token_escrow", launch_id.to_le_bytes().as_ref()],
        bump,
        token::mint = chimp_mint,
        token::authority = launch_config
    )]
    pub token_escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = admin_token_account.mint == chimp_mint.key(),
        constraint = admin_token_account.owner == admin.key()
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"launch_config", launch_config.launch_id.to_le_bytes().as_ref()],
        bump = launch_config.bump
    )]
    pub launch_config: Account<'info, LaunchConfig>,

    #[account(
        mut,
        seeds = [b"sol_vault", launch_config.launch_id.to_le_bytes().as_ref()],
        bump = launch_config.vault_bump
    )]
    /// CHECK: Validated via seeds & bump
    pub sol_vault: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = participant,
        space = UserContribution::LEN,
        seeds = [
            b"contribution",
            launch_config.launch_id.to_le_bytes().as_ref(),
            participant.key().as_ref()
        ],
        bump
    )]
    pub user_contribution: Account<'info, UserContribution>,

    #[account(mut)]
    pub participant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeLaunch<'info> {
    #[account(
        mut,
        seeds = [b"launch_config", launch_config.launch_id.to_le_bytes().as_ref()],
        bump = launch_config.bump
    )]
    pub launch_config: Account<'info, LaunchConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimAllocation<'info> {
    #[account(
        mut,
        seeds = [b"launch_config", launch_config.launch_id.to_le_bytes().as_ref()],
        bump = launch_config.bump
    )]
    pub launch_config: Account<'info, LaunchConfig>,

    #[account(
        mut,
        seeds = [b"token_escrow", launch_config.launch_id.to_le_bytes().as_ref()],
        bump
    )]
    pub token_escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [
            b"contribution",
            launch_config.launch_id.to_le_bytes().as_ref(),
            participant.key().as_ref()
        ],
        bump = user_contribution.bump,
        has_one = participant
    )]
    pub user_contribution: Account<'info, UserContribution>,

    #[account(
        mut,
        constraint = user_token_account.mint == launch_config.chimp_mint,
        constraint = user_token_account.owner == participant.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub participant: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
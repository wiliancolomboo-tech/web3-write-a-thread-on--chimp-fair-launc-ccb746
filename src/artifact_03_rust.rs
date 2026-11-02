use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("CH1MP11111111111111111111111111111111111111");

pub const CONFIG_SEED: &[u8] = b"chimp_config";
pub const VAULT_SEED: &[u8] = b"chimp_vault";
pub const USER_ESCROW_SEED: &[u8] = b"user_escrow";
pub const TOKEN_VAULT_SEED: &[u8] = b"token_vault";

#[program]
pub mod chimp_fair_launch {
    use super::*;

    /// Initializes the $CHIMP Fair Launch parameters and token reserve vault.
    pub fn initialize_launch(
        ctx: Context<InitializeLaunch>,
        total_tokens_for_sale: u64,
        tokens_for_liquidity: u64,
        soft_cap_lamports: u64,
        hard_cap_lamports: u64,
        max_contribution_per_user: u64,
        start_slot: u64,
        end_slot: u64,
    ) -> Result<()> {
        require!(start_slot < end_slot, ChimpError::InvalidSlotBounds);
        require!(soft_cap_lamports <= hard_cap_lamports, ChimpError::InvalidCapBounds);
        require!(total_tokens_for_sale > 0, ChimpError::ZeroTokensAllocation);
        require!(tokens_for_liquidity > 0, ChimpError::ZeroTokensAllocation);

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.token_mint = ctx.accounts.token_mint.key();
        config.total_tokens_for_sale = total_tokens_for_sale;
        config.tokens_for_liquidity = tokens_for_liquidity;
        config.soft_cap_lamports = soft_cap_lamports;
        config.hard_cap_lamports = hard_cap_lamports;
        config.max_contribution_per_user = max_contribution_per_user;
        config.start_slot = start_slot;
        config.end_slot = end_slot;
        config.total_sol_deposited = 0;
        config.total_tokens_claimed = 0;
        config.finalized = false;
        config.liquidity_migrated = false;
        config.bump = ctx.bumps.config;
        config.vault_bump = ctx.bumps.sol_vault;

        // Transfer tokens to the program's escrow vault
        let total_tokens_required = total_tokens_for_sale
            .checked_add(tokens_for_liquidity)
            .ok_or(ChimpError::NumericalOverflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.admin_token_account.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.admin.to_account_info(),
                },
            ),
            total_tokens_required,
        )?;

        emit!(LaunchInitializedEvent {
            token_mint: ctx.accounts.token_mint.key(),
            total_tokens_for_sale,
            tokens_for_liquidity,
            start_slot,
            end_slot,
        });

        Ok(())
    }

    /// Deposits native SOL during the open commit window.
    pub fn commit_sol(ctx: Context<CommitSol>, amount: u64) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let config = &mut ctx.accounts.config;

        require!(current_slot >= config.start_slot, ChimpError::LaunchNotStarted);
        require!(current_slot <= config.end_slot, ChimpError::LaunchEnded);
        require!(!config.finalized, ChimpError::AlreadyFinalized);
        require!(amount > 0, ChimpError::ZeroDeposit);

        let user_escrow = &mut ctx.accounts.user_escrow;
        let new_user_total = user_escrow
            .deposited_lamports
            .checked_add(amount)
            .ok_or(ChimpError::NumericalOverflow)?;

        require!(
            new_user_total <= config.max_contribution_per_user,
            ChimpError::ExceedsUserCap
        );

        // Native SOL transfer to program PDA vault
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            ),
            amount,
        )?;

        user_escrow.user = ctx.accounts.user.key();
        user_escrow.deposited_lamports = new_user_total;
        user_escrow.bump = ctx.bumps.user_escrow;

        config.total_sol_deposited = config
            .total_sol_deposited
            .checked_add(amount)
            .ok_or(ChimpError::NumericalOverflow)?;

        emit!(CommitEvent {
            user: ctx.accounts.user.key(),
            amount,
            total_user_deposit: new_user_total,
            total_vault_sol: config.total_sol_deposited,
            slot: current_slot,
        });

        Ok(())
    }

    /// Closes epoch after end_slot, calculating clearance rates.
    pub fn finalize_launch(ctx: Context<FinalizeLaunch>) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let config = &mut ctx.accounts.config;

        require!(
            current_slot > config.end_slot || config.total_sol_deposited >= config.hard_cap_lamports,
            ChimpError::LaunchWindowStillActive
        );
        require!(!config.finalized, ChimpError::AlreadyFinalized);

        config.finalized = true;

        emit!(LaunchFinalizedEvent {
            total_sol_collected: config.total_sol_deposited,
            is_soft_cap_reached: config.total_sol_deposited >= config.soft_cap_lamports,
            slot: current_slot,
        });

        Ok(())
    }

    /// Claim proportional $CHIMP allocation and refunds of excess SOL (if oversubscribed).
    pub fn claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
        let config = &ctx.accounts.config;
        let user_escrow = &mut ctx.accounts.user_escrow;

        require!(config.finalized, ChimpError::LaunchNotFinalized);
        require!(!user_escrow.claimed, ChimpError::AlreadyClaimed);
        require!(user_escrow.deposited_lamports > 0, ChimpError::NoDeposit);

        user_escrow.claimed = true;

        // Check if soft cap was hit; if not, execute 100% SOL refund
        if config.total_sol_deposited < config.soft_cap_lamports {
            let refund_amount = user_escrow.deposited_lamports;
            let signer_seeds: &[&[&[u8]]] = &[&[
                VAULT_SEED,
                config.to_account_info().key.as_ref(),
                &[config.vault_bump],
            ]];

            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.sol_vault.to_account_info(),
                        to: ctx.accounts.user.to_account_info(),
                    },
                    signer_seeds,
                ),
                refund_amount,
            )?;

            emit!(RefundProcessedEvent {
                user: ctx.accounts.user.key(),
                sol_refunded: refund_amount,
            });
            return Ok(());
        }

        // Pro-rata mathematical distribution
        let effective_sol_pool = std::cmp::min(config.total_sol_deposited, config.hard_cap_lamports);

        // Tokens owed = (user_deposit * total_tokens_for_sale) / total_sol_deposited
        let token_reward = (user_escrow.deposited_lamports as u128)
            .checked_mul(config.total_tokens_for_sale as u128)
            .ok_or(ChimpError::NumericalOverflow)?
            .checked_div(config.total_sol_deposited as u128)
            .ok_or(ChimpError::NumericalOverflow)? as u64;

        // Calculate excess SOL refund if oversubscribed
        let mut sol_refund: u64 = 0;
        if config.total_sol_deposited > config.hard_cap_lamports {
            let user_pro_rata_cap_sol = (user_escrow.deposited_lamports as u128)
                .checked_mul(effective_sol_pool as u128)
                .ok_or(ChimpError::NumericalOverflow)?
                .checked_div(config.total_sol_deposited as u128)
                .ok_or(ChimpError::NumericalOverflow)? as u64;

            sol_refund = user_escrow
                .deposited_lamports
                .checked_sub(user_pro_rata_cap_sol)
                .ok_or(ChimpError::NumericalOverflow)?;
        }

        // 1. Transfer $CHIMP token allocation from vault to user
        let mint_key = config.token_mint;
        let config_seeds: &[&[&[u8]]] = &[&[
            CONFIG_SEED,
            mint_key.as_ref(),
            &[config.bump],
        ]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.token_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                config_seeds,
            ),
            token_reward,
        )?;

        // 2. Transfer excess SOL refund if applicable
        if sol_refund > 0 {
            let signer_seeds: &[&[&[u8]]] = &[&[
                VAULT_SEED,
                config.to_account_info().key.as_ref(),
                &[config.vault_bump],
            ]];

            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.sol_vault.to_account_info(),
                        to: ctx.accounts.user.to_account_info(),
                    },
                    signer_seeds,
                ),
                sol_refund,
            )?;
        }

        emit!(ClaimProcessedEvent {
            user: ctx.accounts.user.key(),
            tokens_claimed: token_reward,
            sol_refunded: sol_refund,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Account Context Structs
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeLaunch<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = 8 + LaunchConfig::INIT_SPACE,
        seeds = [CONFIG_SEED, token_mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, LaunchConfig>,

    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump
    )]
    /// CHECK: Vault PDA to store incoming native SOL
    pub sol_vault: AccountInfo<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [TOKEN_VAULT_SEED, config.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = config,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = admin_token_account.mint == token_mint.key(),
        constraint = admin_token_account.owner == admin.key()
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CommitSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED, config.token_mint.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, LaunchConfig>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserEscrow::INIT_SPACE,
        seeds = [USER_ESCROW_SEED, config.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_escrow: Account<'info, UserEscrow>,

    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump
    )]
    /// CHECK: Verified via seeds and bump
    pub sol_vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeLaunch<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.token_mint.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, LaunchConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.token_mint.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, LaunchConfig>,

    #[account(
        mut,
        seeds = [USER_ESCROW_SEED, config.key().as_ref(), user.key().as_ref()],
        bump = user_escrow.bump
    )]
    pub user_escrow: Account<'info, UserEscrow>,

    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump
    )]
    /// CHECK: Vault PDA holds SOL
    pub sol_vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [TOKEN_VAULT_SEED, config.key().as_ref()],
        bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = token_mint,
        associated_token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// State Accounts
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct LaunchConfig {
    pub admin: Pubkey,
    pub token_mint: Pubkey,
    pub total_tokens_for_sale: u64,
    pub tokens_for_liquidity: u64,
    pub soft_cap_lamports: u64,
    pub hard_cap_lamports: u64,
    pub max_contribution_per_user: u64,
    pub start_slot: u64,
    pub end_slot: u64,
    pub total_sol_deposited: u64,
    pub total_tokens_claimed: u64,
    pub finalized: bool,
    pub liquidity_migrated: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserEscrow {
    pub user: Pubkey,
    pub deposited_lamports: u64,
    pub claimed: bool,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// Events & Errors
// -----------------------------------------------------------------------------

#[event]
pub struct LaunchInitializedEvent {
    pub token_mint: Pubkey,
    pub total_tokens_for_sale: u64,
    pub tokens_for_liquidity: u64,
    pub start_slot: u64,
    pub end_slot: u64,
}

#[event]
pub struct CommitEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub total_user_deposit: u64,
    pub total_vault_sol: u64,
    pub slot: u64,
}

#[event]
pub struct LaunchFinalizedEvent {
    pub total_sol_collected: u64,
    pub is_soft_cap_reached: bool,
    pub slot: u64,
}

#[event]
pub struct ClaimProcessedEvent {
    pub user: Pubkey,
    pub tokens_claimed: u64,
    pub sol_refunded: u64,
}

#[event]
pub struct RefundProcessedEvent {
    pub user: Pubkey,
    pub sol_refunded: u64,
}

#[error_code]
pub enum ChimpError {
    #[msg("Slot window is invalid: start_slot must be < end_slot.")]
    InvalidSlotBounds,
    #[msg("Soft cap cannot exceed hard cap.")]
    InvalidCapBounds,
    #[msg("Allocation amount must be strictly greater than 0.")]
    ZeroTokensAllocation,
    #[msg("Launch commit window has not started yet.")]
    LaunchNotStarted,
    #[msg("Launch commit window has ended.")]
    LaunchEnded,
    #[msg("Fair launch is already finalized.")]
    AlreadyFinalized,
    #[msg("Deposit amount must be greater than zero.")]
    ZeroDeposit,
    #[msg("Deposit exceeds maximum per-wallet contribution limit.")]
    ExceedsUserCap,
    #[msg("Launch cannot be finalized before end_slot unless hard cap is reached.")]
    LaunchWindowStillActive,
    #[msg("Launch must be finalized before claims/refunds can be executed.")]
    LaunchNotFinalized,
    #[msg("Tokens or refund have already been claimed.")]
    AlreadyClaimed,
    #[msg("No active deposit found for this account.")]
    NoDeposit,
    #[msg("Numerical overflow/underflow occurred in mathematical calculation.")]
    NumericalOverflow,
}
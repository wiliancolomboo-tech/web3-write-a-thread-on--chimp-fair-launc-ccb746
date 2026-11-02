use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

declare_id!("Ch1mpFa1rLaunch111111111111111111111111111111");

pub const VAULT_SEED: &[u8] = b"vault";
pub const USER_POSITION_SEED: &[u8] = b"user_position";
pub const CONFIG_SEED: &[u8] = b"launch_config";

#[program]
pub mod chimp_fair_launch {
    use super::*;

    pub fn initialize_launch(
        ctx: Context<InitializeLaunch>,
        total_tokens_offered: u64,
        soft_cap_lamports: u64,
        hard_cap_lamports: u64,
        start_slot: u64,
        end_slot: u64,
    ) -> Result<()> {
        require!(
            end_slot > start_slot,
            FairLaunchError::InvalidSlotRange
        );
        require!(
            hard_cap_lamports >= soft_cap_lamports,
            FairLaunchError::InvalidCapRange
        );
        require!(
            total_tokens_offered > 0,
            FairLaunchError::ZeroTokenOffering
        );

        let launch_config = &mut ctx.accounts.launch_config;
        launch_config.authority = ctx.accounts.authority.key();
        launch_config.token_mint = ctx.accounts.token_mint.key();
        launch_config.pool_token_account = ctx.accounts.pool_token_account.key();
        launch_config.vault_bump = ctx.bumps.vault_pda;
        launch_config.config_bump = ctx.bumps.launch_config;
        launch_config.total_tokens_offered = total_tokens_offered;
        launch_config.soft_cap_lamports = soft_cap_lamports;
        launch_config.hard_cap_lamports = hard_cap_lamports;
        launch_config.start_slot = start_slot;
        launch_config.end_slot = end_slot;
        launch_config.total_sol_deposited = 0;
        launch_config.is_finalized = false;
        launch_config.tokens_deposited = false;

        emit!(LaunchInitializedEvent {
            token_mint: launch_config.token_mint,
            total_tokens: total_tokens_offered,
            start_slot,
            end_slot,
            hard_cap: hard_cap_lamports,
        });

        Ok(())
    }

    pub fn deposit_pool_tokens(
        ctx: Context<DepositPoolTokens>,
        amount: u64,
    ) -> Result<()> {
        let launch_config = &mut ctx.accounts.launch_config;
        require!(
            !launch_config.tokens_deposited,
            FairLaunchError::TokensAlreadyDeposited
        );
        require!(
            amount == launch_config.total_tokens_offered,
            FairLaunchError::DepositAmountMismatch
        );

        let cpi_accounts = SplTransfer {
            from: ctx.accounts.authority_token_account.to_account_info(),
            to: ctx.accounts.pool_token_account.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        launch_config.tokens_deposited = true;

        emit!(TokensDepositedEvent {
            mint: launch_config.token_mint,
            amount,
        });

        Ok(())
    }

    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        let clock = Clock::get()?;
        let current_slot = clock.slot;
        let launch_config = &mut ctx.accounts.launch_config;

        require!(
            current_slot >= launch_config.start_slot,
            FairLaunchError::LaunchNotActive
        );
        require!(
            current_slot <= launch_config.end_slot,
            FairLaunchError::LaunchExpired
        );
        require!(
            !launch_config.is_finalized,
            FairLaunchError::LaunchFinalized
        );
        require!(amount > 0, FairLaunchError::ZeroDeposit);

        // Native SOL transfer into program-controlled escrow PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.vault_pda.to_account_info(),
            },
        );
        transfer(cpi_context, amount)?;

        // Update balances
        launch_config.total_sol_deposited = launch_config
            .total_sol_deposited
            .checked_add(amount)
            .ok_or(FairLaunchError::MathOverflow)?;

        let position = &mut ctx.accounts.user_position;
        if position.owner == Pubkey::default() {
            position.owner = ctx.accounts.user.key();
            position.launch_config = launch_config.key();
            position.deposited_lamports = 0;
            position.claimed = false;
        }

        position.deposited_lamports = position
            .deposited_lamports
            .checked_add(amount)
            .ok_or(FairLaunchError::MathOverflow)?;

        emit!(SolDepositedEvent {
            user: ctx.accounts.user.key(),
            amount,
            cumulative_user: position.deposited_lamports,
            total_vault_sol: launch_config.total_sol_deposited,
        });

        Ok(())
    }

    pub fn finalize_launch(ctx: Context<FinalizeLaunch>) -> Result<()> {
        let clock = Clock::get()?;
        let current_slot = clock.slot;
        let launch_config = &mut ctx.accounts.launch_config;

        require!(
            current_slot > launch_config.end_slot,
            FairLaunchError::EpochStillRunning
        );
        require!(
            !launch_config.is_finalized,
            FairLaunchError::LaunchFinalized
        );
        require!(
            launch_config.tokens_deposited,
            FairLaunchError::PoolTokensNotDeposited
        );

        launch_config.is_finalized = true;

        emit!(LaunchFinalizedEvent {
            total_raised: launch_config.total_sol_deposited,
            hard_cap: launch_config.hard_cap_lamports,
            soft_cap: launch_config.soft_cap_lamports,
            is_successful: launch_config.total_sol_deposited >= launch_config.soft_cap_lamports,
        });

        Ok(())
    }

    pub fn claim_and_refund(ctx: Context<ClaimAndRefund>) -> Result<()> {
        let launch_config = &ctx.accounts.launch_config;
        let user_position = &mut ctx.accounts.user_position;

        require!(
            launch_config.is_finalized,
            FairLaunchError::LaunchNotFinalized
        );
        require!(!user_position.claimed, FairLaunchError::AlreadyClaimed);
        require!(
            user_position.deposited_lamports > 0,
            FairLaunchError::ZeroDeposit
        );

        user_position.claimed = true;

        let total_raised = launch_config.total_sol_deposited;
        let user_contrib = user_position.deposited_lamports;
        let soft_cap = launch_config.soft_cap_lamports;
        let hard_cap = launch_config.hard_cap_lamports;

        // SCENARIO 1: Soft Cap Failed -> 100% Refund
        if total_raised < soft_cap {
            let vault_bump = launch_config.vault_bump;
            let config_key = launch_config.key();
            let seeds = &[
                VAULT_SEED,
                config_key.as_ref(),
                &[vault_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            **ctx.accounts.vault_pda.try_borrow_mut_lamports()? -= user_contrib;
            **ctx.accounts.user.try_borrow_mut_lamports()? += user_contrib;

            emit!(RefundProcessedEvent {
                user: ctx.accounts.user.key(),
                sol_refunded: user_contrib,
                tokens_claimed: 0,
            });
            return Ok(());
        }

        // SCENARIO 2: Successful Launch (Pro-Rata Calculation)
        let (tokens_owed, sol_refund) = if total_raised > hard_cap {
            // Raised above hardcap -> Scale token share & refund excess SOL
            // effective_fraction = user_contrib / total_raised
            // tokens = user_contrib * total_tokens / total_raised
            // user_absorbed_sol = user_contrib * hard_cap / total_raised
            // refund = user_contrib - user_absorbed_sol
            let tokens = (user_contrib as u128)
                .checked_mul(launch_config.total_tokens_offered as u128)
                .ok_or(FairLaunchError::MathOverflow)?
                .checked_div(total_raised as u128)
                .ok_or(FairLaunchError::MathOverflow)? as u64;

            let sol_used = (user_contrib as u128)
                .checked_mul(hard_cap as u128)
                .ok_or(FairLaunchError::MathOverflow)?
                .checked_div(total_raised as u128)
                .ok_or(FairLaunchError::MathOverflow)? as u64;

            let refund = user_contrib
                .checked_sub(sol_used)
                .ok_or(FairLaunchError::MathOverflow)?;

            (tokens, refund)
        } else {
            // Total raised is between soft cap and hard cap
            // tokens = user_contrib * total_tokens / total_raised
            let tokens = (user_contrib as u128)
                .checked_mul(launch_config.total_tokens_offered as u128)
                .ok_or(FairLaunchError::MathOverflow)?
                .checked_div(total_raised as u128)
                .ok_or(FairLaunchError::MathOverflow)? as u64;
            (tokens, 0)
        };

        // Transfer SOL refund if any
        if sol_refund > 0 {
            **ctx.accounts.vault_pda.try_borrow_mut_lamports()? -= sol_refund;
            **ctx.accounts.user.try_borrow_mut_lamports()? += sol_refund;
        }

        // Transfer $CHIMP Tokens via PDA signing authority
        if tokens_owed > 0 {
            let vault_bump = launch_config.vault_bump;
            let config_key = launch_config.key();
            let seeds = &[
                VAULT_SEED,
                config_key.as_ref(),
                &[vault_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            let cpi_accounts = SplTransfer {
                from: ctx.accounts.pool_token_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.vault_pda.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
            token::transfer(cpi_ctx, tokens_owed)?;
        }

        emit!(AllocationClaimedEvent {
            user: ctx.accounts.user.key(),
            tokens_claimed: tokens_owed,
            sol_refunded: sol_refund,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeLaunch<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + LaunchConfig::INIT_SPACE,
        seeds = [CONFIG_SEED, token_mint.key().as_ref()],
        bump
    )]
    pub launch_config: Account<'info, LaunchConfig>,

    #[account(
        seeds = [VAULT_SEED, launch_config.key().as_ref()],
        bump
    )]
    /// CHECK: Native lamports custody account controlled by PDA seeds
    pub vault_pda: AccountInfo<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint,
        token::authority = vault_pda
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositPoolTokens<'info> {
    #[account(
        mut,
        has_one = authority,
        has_one = pool_token_account
    )]
    pub launch_config: Account<'info, LaunchConfig>,

    #[account(mut)]
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = launch_config.token_mint,
        token::authority = authority
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub launch_config: Account<'info, LaunchConfig>,

    #[account(
        mut,
        seeds = [VAULT_SEED, launch_config.key().as_ref()],
        bump = launch_config.vault_bump
    )]
    /// CHECK: Checked via PDA derivation seeds
    pub vault_pda: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::INIT_SPACE,
        seeds = [USER_POSITION_SEED, launch_config.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeLaunch<'info> {
    #[account(mut)]
    pub launch_config: Account<'info, LaunchConfig>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimAndRefund<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, launch_config.token_mint.as_ref()],
        bump = launch_config.config_bump
    )]
    pub launch_config: Account<'info, LaunchConfig>,

    #[account(
        mut,
        seeds = [VAULT_SEED, launch_config.key().as_ref()],
        bump = launch_config.vault_bump
    )]
    /// CHECK: Lamport release validated by PDA seeds
    pub vault_pda: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [USER_POSITION_SEED, launch_config.key().as_ref(), user.key().as_ref()],
        bump,
        has_one = user
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(
        mut,
        seeds = [launch_config.pool_token_account.as_ref()],
        bump,
        constraint = pool_token_account.key() == launch_config.pool_token_account
    )]
    pub pool_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = launch_config.token_mint,
        token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// DATA STATE STRUCTURES
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct LaunchConfig {
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub pool_token_account: Pubkey,
    pub vault_bump: u8,
    pub config_bump: u8,
    pub total_tokens_offered: u64,
    pub soft_cap_lamports: u64,
    pub hard_cap_lamports: u64,
    pub start_slot: u64,
    pub end_slot: u64,
    pub total_sol_deposited: u64,
    pub is_finalized: bool,
    pub tokens_deposited: bool,
}

#[account]
#[derive(InitSpace)]
pub struct UserPosition {
    pub owner: Pubkey,
    pub launch_config: Pubkey,
    pub deposited_lamports: u64,
    pub claimed: bool,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct LaunchInitializedEvent {
    pub token_mint: Pubkey,
    pub total_tokens: u64,
    pub start_slot: u64,
    pub end_slot: u64,
    pub hard_cap: u64,
}

#[event]
pub struct TokensDepositedEvent {
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SolDepositedEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub cumulative_user: u64,
    pub total_vault_sol: u64,
}

#[event]
pub struct LaunchFinalizedEvent {
    pub total_raised: u64,
    pub hard_cap: u64,
    pub soft_cap: u64,
    pub is_successful: bool,
}

#[event]
pub struct AllocationClaimedEvent {
    pub user: Pubkey,
    pub tokens_claimed: u64,
    pub sol_refunded: u64,
}

#[event]
pub struct RefundProcessedEvent {
    pub user: Pubkey,
    pub sol_refunded: u64,
    pub tokens_claimed: u64,
}

#[error_code]
pub enum FairLaunchError {
    #[msg("Invalid slot range specified")]
    InvalidSlotRange,
    #[msg("Hard cap must be greater than or equal to soft cap")]
    InvalidCapRange,
    #[msg("Total tokens offered must be strictly positive")]
    ZeroTokenOffering,
    #[msg("Tokens have already been transferred into escrow")]
    TokensAlreadyDeposited,
    #[msg("Token deposit amount does not equal total tokens offered")]
    DepositAmountMismatch,
    #[msg("Fair launch is not currently active")]
    LaunchNotActive,
    #[msg("Fair launch participation window has expired")]
    LaunchExpired,
    #[msg("Fair launch has already been finalized")]
    LaunchFinalized,
    #[msg("Deposit amount must be strictly greater than zero")]
    ZeroDeposit,
    #[msg("Mathematical overflow occurred during clearing calculations")]
    MathOverflow,
    #[msg("Fair launch participation window has not yet concluded")]
    EpochStillRunning,
    #[msg("Offering tokens have not yet been deposited to pool escrow")]
    PoolTokensNotDeposited,
    #[msg("Fair launch has not yet been finalized")]
    LaunchNotFinalized,
    #[msg("Allocations or refunds have already been claimed for this address")]
    AlreadyClaimed,
}
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Ch1mpFa1rLaunch11111111111111111111111111111");

pub const POOL_SEED: &[u8] = b"chimp_pool";
pub const VAULT_SEED: &[u8] = b"vault_escrow";
pub const USER_CONTRIBUTION_SEED: &[u8] = b"user_contribution";

#[program]
pub mod chimp_fair_launch {
    use super::*;

    /// Initializes the Fair Launch pool with configurable slot boundaries and hard/soft caps.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        total_tokens_for_sale: u64,
        min_contribution_lamports: u64,
        max_contribution_per_wallet: u64,
        target_soft_cap: u64,
        hard_cap: u64,
        start_slot: u64,
        end_slot: u64,
    ) -> Result<()> {
        require!(start_slot < end_slot, LaunchError::InvalidSlotBounds);
        require!(min_contribution_lamports > 0, LaunchError::ZeroContributionBoundary);
        require!(
            min_contribution_lamports <= max_contribution_per_wallet,
            LaunchError::InvalidContributionLimits
        );
        require!(target_soft_cap <= hard_cap, LaunchError::InvalidCapBoundaries);
        require!(total_tokens_for_sale > 0, LaunchError::ZeroTokensForSale);

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.token_vault = ctx.accounts.token_vault.key();
        pool.vault_escrow_bump = ctx.bumps.vault_escrow;
        pool.pool_bump = ctx.bumps.pool;
        pool.total_tokens_for_sale = total_tokens_for_sale;
        pool.min_contribution_lamports = min_contribution_lamports;
        pool.max_contribution_per_wallet = max_contribution_per_wallet;
        pool.target_soft_cap = target_soft_cap;
        pool.hard_cap = hard_cap;
        pool.start_slot = start_slot;
        pool.end_slot = end_slot;
        pool.total_sol_collected = 0;
        pool.is_finalized = false;
        pool.is_cancelled = false;

        // Deposit all launch tokens from authority into the protocol vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.authority_token_account.to_account_info(),
            to: ctx.accounts.token_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, total_tokens_for_sale)?;

        emit!(PoolInitializedEvent {
            pool: pool.key(),
            token_mint: pool.token_mint,
            start_slot,
            end_slot,
            hard_cap,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// User commits SOL into the pool escrow. Fully MEV/Frontrun-protected via Pro-Rata settlement.
    pub fn deposit_sol(ctx: Context<DepositSol>, lamports: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let current_slot = Clock::get()?.slot;

        require!(!pool.is_finalized && !pool.is_cancelled, LaunchError::PoolClosed);
        require!(current_slot >= pool.start_slot, LaunchError::PoolNotStarted);
        require!(current_slot <= pool.end_slot, LaunchError::PoolEnded);

        let user_record = &mut ctx.accounts.user_contribution;
        let new_user_total = user_record
            .lamports_contributed
            .checked_add(lamports)
            .ok_or(LaunchError::MathOverflow)?;

        require!(
            new_user_total >= pool.min_contribution_lamports,
            LaunchError::BelowMinContribution
        );
        require!(
            new_user_total <= pool.max_contribution_per_wallet,
            LaunchError::ExceedsWalletLimit
        );

        let new_pool_total = pool
            .total_sol_collected
            .checked_add(lamports)
            .ok_or(LaunchError::MathOverflow)?;
        require!(new_pool_total <= pool.hard_cap, LaunchError::HardCapExceeded);

        // Perform CPI transfer of SOL from user to program-owned vault escrow
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.vault_escrow.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, lamports)?;

        user_record.user = ctx.accounts.user.key();
        user_record.lamports_contributed = new_user_total;
        user_record.claimed = false;
        pool.total_sol_collected = new_pool_total;

        emit!(ContributionEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount: lamports,
            user_total: new_user_total,
            pool_total: new_pool_total,
            slot: current_slot,
        });

        Ok(())
    }

    /// Finalizes the fair launch once slot bounds are satisfied or hard cap is attained.
    pub fn finalize_pool(ctx: Context<FinalizePool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let current_slot = Clock::get()?.slot;

        require!(!pool.is_finalized && !pool.is_cancelled, LaunchError::PoolClosed);
        require!(
            current_slot > pool.end_slot || pool.total_sol_collected >= pool.hard_cap,
            LaunchError::PoolConditionsNotMet
        );

        pool.is_finalized = true;

        emit!(PoolFinalizedEvent {
            pool: pool.key(),
            total_sol_collected: pool.total_sol_collected,
            tokens_for_sale: pool.total_tokens_for_sale,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Claim entitled $CHIMP tokens after pool finalization based on pro-rata contribution.
    pub fn claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
        let pool = &ctx.accounts.pool;
        require!(pool.is_finalized, LaunchError::PoolNotFinalized);

        let user_record = &mut ctx.accounts.user_contribution;
        require!(!user_record.claimed, LaunchError::AlreadyClaimed);
        require!(user_record.lamports_contributed > 0, LaunchError::NoContribution);

        // Mathematical Pro-Rata Share: (user_sol * total_tokens) / total_pool_sol
        let token_reward = (user_record.lamports_contributed as u128)
            .checked_mul(pool.total_tokens_for_sale as u128)
            .ok_or(LaunchError::MathOverflow)?
            .checked_div(pool.total_sol_collected as u128)
            .ok_or(LaunchError::MathOverflow)? as u64;

        user_record.claimed = true;

        let seeds = &[
            POOL_SEED,
            pool.token_mint.as_ref(),
            &[pool.pool_bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.token_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, token_reward)?;

        emit!(TokensClaimedEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            tokens_claimed: token_reward,
            lamports_burned: user_record.lamports_contributed,
        });

        Ok(())
    }

    /// Admin emergency action: enables refunds if soft cap is not reached post end_slot.
    pub fn cancel_pool(ctx: Context<CancelPool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let current_slot = Clock::get()?.slot;

        require!(!pool.is_finalized && !pool.is_cancelled, LaunchError::PoolClosed);
        require!(current_slot > pool.end_slot, LaunchError::PoolNotEnded);
        require!(pool.total_sol_collected < pool.target_soft_cap, LaunchError::SoftCapReached);

        pool.is_cancelled = true;

        emit!(PoolCancelledEvent {
            pool: pool.key(),
            total_sol_collected: pool.total_sol_collected,
        });

        Ok(())
    }

    /// Allows contributors to reclaim 100% of their deposited SOL if pool was cancelled.
    pub fn refund_sol(ctx: Context<RefundSol>) -> Result<()> {
        let pool = &ctx.accounts.pool;
        require!(pool.is_cancelled, LaunchError::PoolNotCancelled);

        let user_record = &mut ctx.accounts.user_contribution;
        require!(!user_record.claimed, LaunchError::AlreadyClaimed);
        let refund_amount = user_record.lamports_contributed;
        require!(refund_amount > 0, LaunchError::NoContribution);

        user_record.claimed = true;
        user_record.lamports_contributed = 0;

        let pool_key = pool.key();
        let seeds = &[
            VAULT_SEED,
            pool_key.as_ref(),
            &[pool.vault_escrow_bump],
        ];
        let signer = &[&seeds[..]];

        **ctx.accounts.vault_escrow.try_borrow_mut_lamports()? = ctx
            .accounts
            .vault_escrow
            .lamports()
            .checked_sub(refund_amount)
            .ok_or(LaunchError::MathOverflow)?;

        **ctx.accounts.user.try_borrow_mut_lamports()? = ctx
            .accounts
            .user
            .lamports()
            .checked_add(refund_amount)
            .ok_or(LaunchError::MathOverflow)?;

        emit!(RefundIssuedEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            refunded_lamports: refund_amount,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + LaunchPool::INIT_SPACE,
        seeds = [POOL_SEED, token_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, LaunchPool>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint,
        token::authority = pool,
        seeds = [b"token_vault", pool.key().as_ref()],
        bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = authority
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    /// CHECK: System account PDA storing committed SOL lamports.
    #[account(
        mut,
        seeds = [VAULT_SEED, pool.key().as_ref()],
        bump
    )]
    pub vault_escrow: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED, pool.token_mint.as_ref()],
        bump = pool.pool_bump
    )]
    pub pool: Account<'info, LaunchPool>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserContribution::INIT_SPACE,
        seeds = [USER_CONTRIBUTION_SEED, pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_contribution: Account<'info, UserContribution>,

    /// CHECK: Validated via seeds constraint against the pool
    #[account(
        mut,
        seeds = [VAULT_SEED, pool.key().as_ref()],
        bump = pool.vault_escrow_bump
    )]
    pub vault_escrow: AccountInfo<'info>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizePool<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED, pool.token_mint.as_ref()],
        bump = pool.pool_bump
    )]
    pub pool: Account<'info, LaunchPool>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED, pool.token_mint.as_ref()],
        bump = pool.pool_bump
    )]
    pub pool: Account<'info, LaunchPool>,

    #[account(
        mut,
        seeds = [USER_CONTRIBUTION_SEED, pool.key().as_ref(), user.key().as_ref()],
        bump,
        has_one = user
    )]
    pub user_contribution: Account<'info, UserContribution>,

    #[account(
        mut,
        seeds = [b"token_vault", pool.key().as_ref()],
        bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pool.token_mint,
        token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelPool<'info> {
    #[account(
        mut,
        has_one = authority,
        seeds = [POOL_SEED, pool.token_mint.as_ref()],
        bump = pool.pool_bump
    )]
    pub pool: Account<'info, LaunchPool>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefundSol<'info> {
    #[account(
        seeds = [POOL_SEED, pool.token_mint.as_ref()],
        bump = pool.pool_bump
    )]
    pub pool: Account<'info, LaunchPool>,

    #[account(
        mut,
        seeds = [USER_CONTRIBUTION_SEED, pool.key().as_ref(), user.key().as_ref()],
        bump,
        has_one = user
    )]
    pub user_contribution: Account<'info, UserContribution>,

    /// CHECK: Sol escrow account for refunds
    #[account(
        mut,
        seeds = [VAULT_SEED, pool.key().as_ref()],
        bump = pool.vault_escrow_bump
    )]
    pub vault_escrow: AccountInfo<'info>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------------
// State Accounts
// ---------------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct LaunchPool {
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub token_vault: Pubkey,
    pub vault_escrow_bump: u8,
    pub pool_bump: u8,
    pub total_tokens_for_sale: u64,
    pub min_contribution_lamports: u64,
    pub max_contribution_per_wallet: u64,
    pub target_soft_cap: u64,
    pub hard_cap: u64,
    pub start_slot: u64,
    pub end_slot: u64,
    pub total_sol_collected: u64,
    pub is_finalized: bool,
    pub is_cancelled: bool,
}

#[account]
#[derive(InitSpace)]
pub struct UserContribution {
    pub user: Pubkey,
    pub lamports_contributed: u64,
    pub claimed: bool,
}

// ---------------------------------------------------------------------------------
// Events & Errors
// ---------------------------------------------------------------------------------

#[event]
pub struct PoolInitializedEvent {
    pub pool: Pubkey,
    pub token_mint: Pubkey,
    pub start_slot: u64,
    pub end_slot: u64,
    pub hard_cap: u64,
    pub timestamp: i64,
}

#[event]
pub struct ContributionEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub user_total: u64,
    pub pool_total: u64,
    pub slot: u64,
}

#[event]
pub struct PoolFinalizedEvent {
    pub pool: Pubkey,
    pub total_sol_collected: u64,
    pub tokens_for_sale: u64,
    pub timestamp: i64,
}

#[event]
pub struct TokensClaimedEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub tokens_claimed: u64,
    pub lamports_burned: u64,
}

#[event]
pub struct PoolCancelledEvent {
    pub pool: Pubkey,
    pub total_sol_collected: u64,
}

#[event]
pub struct RefundIssuedEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub refunded_lamports: u64,
}

#[error_code]
pub enum LaunchError {
    #[msg("Invalid slot boundaries: start_slot must be strictly lower than end_slot.")]
    InvalidSlotBounds,
    #[msg("Minimum contribution lamports must be non-zero.")]
    ZeroContributionBoundary,
    #[msg("Minimum contribution cannot exceed max contribution per wallet.")]
    InvalidContributionLimits,
    #[msg("Target soft cap must be lower than or equal to hard cap.")]
    InvalidCapBoundaries,
    #[msg("Tokens for sale must be greater than zero.")]
    ZeroTokensForSale,
    #[msg("The Fair Launch pool is currently inactive or closed.")]
    PoolClosed,
    #[msg("The Fair Launch has not started yet.")]
    PoolNotStarted,
    #[msg("The Fair Launch slot window has elapsed.")]
    PoolEnded,
    #[msg("Deposit amount is strictly below the minimum individual contribution boundary.")]
    BelowMinContribution,
    #[msg("Deposit amount pushes user past maximum allowed allocation per wallet.")]
    ExceedsWalletLimit,
    #[msg("Deposit pushes the launch pool over its absolute hard cap.")]
    HardCapExceeded,
    #[msg("Mathematical overflow occurred during calculation.")]
    MathOverflow,
    #[msg("Pool finalization conditions not satisfied (slot not passed or hard cap not hit).")]
    PoolConditionsNotMet,
    #[msg("Pool must be finalized prior to token claim execution.")]
    PoolNotFinalized,
    #[msg("Allocation already claimed.")]
    AlreadyClaimed,
    #[msg("No deposited contribution found for this user.")]
    NoContribution,
    #[msg("Pool cannot be cancelled because soft cap was achieved.")]
    SoftCapReached,
    #[msg("Pool slot window has not elapsed yet.")]
    PoolNotEnded,
    #[msg("Pool has not been marked as cancelled.")]
    PoolNotCancelled,
}
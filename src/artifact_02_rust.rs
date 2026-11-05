use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

declare_id!("CH1MP11111111111111111111111111111111111111");

#[program]
pub mod chimp_fair_launch {
    use super::*;

    /// Initialize the $CHIMP Fair Launch pool with target supply, caps, and slot windows.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        pool_name: String,
        token_allocation: u64,
        min_raise: u64,
        max_raise: u64,
        start_slot: u64,
        end_slot: u64,
        max_contribution_per_user: u64,
    ) -> Result<()> {
        require!(pool_name.len() <= 32, FairLaunchError::NameTooLong);
        require!(min_raise > 0, FairLaunchError::InvalidParameters);
        require!(max_raise >= min_raise, FairLaunchError::InvalidParameters);
        require!(start_slot < end_slot, FairLaunchError::InvalidWindow);
        require!(token_allocation > 0, FairLaunchError::ZeroTokenAllocation);

        let current_slot = Clock::get()?.slot;
        require!(start_slot >= current_slot, FairLaunchError::WindowInPast);

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.token_vault = ctx.accounts.token_vault.key();
        pool.sol_vault = ctx.accounts.sol_vault.key();
        pool.pool_name = pool_name;
        pool.token_allocation = token_allocation;
        pool.min_raise = min_raise;
        pool.max_raise = max_raise;
        pool.total_sol_raised = 0;
        pool.start_slot = start_slot;
        pool.end_slot = end_slot;
        pool.max_contribution_per_user = max_contribution_per_user;
        pool.is_finalized = false;
        pool.is_cancelled = false;
        pool.bump = ctx.bumps.pool;
        pool.sol_vault_bump = ctx.bumps.sol_vault;

        // Escrow total allocation of $CHIMP from authority to program vault
        let cpi_accounts = SplTransfer {
            from: ctx.accounts.authority_token_account.to_account_info(),
            to: ctx.accounts.token_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), token_allocation)?;

        emit!(PoolInitializedEvent {
            pool: pool.key(),
            authority: pool.authority,
            token_mint: pool.token_mint,
            token_allocation,
            min_raise,
            max_raise,
            start_slot,
            end_slot,
        });

        Ok(())
    }

    /// User commits native SOL into the vault during the active participation window.
    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let user_contribution = &mut ctx.accounts.user_contribution;
        let current_slot = Clock::get()?.slot;

        require!(!pool.is_finalized && !pool.is_cancelled, FairLaunchError::PoolInactive);
        require!(current_slot >= pool.start_slot, FairLaunchError::LaunchNotStarted);
        require!(current_slot <= pool.end_slot, FairLaunchError::LaunchEnded);
        require!(amount > 0, FairLaunchError::ZeroContribution);

        let new_user_total = user_contribution.sol_amount.checked_add(amount)
            .ok_or(FairLaunchError::MathOverflow)?;
        require!(
            new_user_total <= pool.max_contribution_per_user,
            FairLaunchError::ExceedsUserCap
        );

        let new_pool_total = pool.total_sol_raised.checked_add(amount)
            .ok_or(FairLaunchError::MathOverflow)?;
        require!(new_pool_total <= pool.max_raise, FairLaunchError::ExceedsMaxRaise);

        // Execute SOL transfer to deterministic Sol Vault PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
        );
        transfer(cpi_context, amount)?;

        // Update state
        pool.total_sol_raised = new_pool_total;
        if user_contribution.sol_amount == 0 {
            user_contribution.user = ctx.accounts.user.key();
            user_contribution.pool = pool.key();
            user_contribution.tokens_claimed = false;
            user_contribution.bump = ctx.bumps.user_contribution;
        }
        user_contribution.sol_amount = new_user_total;

        emit!(ContributionMadeEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount,
            total_user_sol: new_user_total,
            total_pool_sol: new_pool_total,
            slot: current_slot,
        });

        Ok(())
    }

    /// Finalize pool state after window closes. Prepares liquidity allocation or triggers cancellation.
    pub fn finalize_pool(ctx: Context<FinalizePool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let current_slot = Clock::get()?.slot;

        require!(!pool.is_finalized, FairLaunchError::AlreadyFinalized);
        require!(
            current_slot > pool.end_slot || pool.total_sol_raised == pool.max_raise,
            FairLaunchError::LaunchStillActive
        );

        if pool.total_sol_raised < pool.min_raise {
            pool.is_cancelled = true;
            pool.is_finalized = true;
            emit!(PoolCancelledEvent {
                pool: pool.key(),
                total_sol_raised: pool.total_sol_raised,
                min_raise: pool.min_raise,
            });
            return Ok(());
        }

        pool.is_finalized = true;

        emit!(PoolFinalizedEvent {
            pool: pool.key(),
            total_sol_raised: pool.total_sol_raised,
            token_allocation: pool.token_allocation,
            final_clearing_ratio: pool.token_allocation as f64 / pool.total_sol_raised as f64,
        });

        Ok(())
    }

    /// Pro-rata token claim execution for participating contributors once finalized.
    pub fn claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let user_contribution = &mut ctx.accounts.user_contribution;

        require!(pool.is_finalized, FairLaunchError::NotFinalized);
        require!(!pool.is_cancelled, FairLaunchError::PoolCancelled);
        require!(!user_contribution.tokens_claimed, FairLaunchError::AlreadyClaimed);
        require!(user_contribution.sol_amount > 0, FairLaunchError::NoContribution);

        // Pro-rata distribution: (user_sol * token_allocation) / total_sol_raised
        let user_token_reward = (user_contribution.sol_amount as u128)
            .checked_mul(pool.token_allocation as u128)
            .ok_or(FairLaunchError::MathOverflow)?
            .checked_div(pool.total_sol_raised as u128)
            .ok_or(FairLaunchError::MathOverflow)? as u64;

        user_contribution.tokens_claimed = true;

        let pool_name = pool.pool_name.as_bytes();
        let seeds = &[
            b"fair_launch".as_ref(),
            pool_name,
            &[pool.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = SplTransfer {
            from: ctx.accounts.token_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: pool.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer),
            user_token_reward,
        )?;

        emit!(TokensClaimedEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount: user_token_reward,
        });

        Ok(())
    }

    /// Claim full SOL refund if minimum raise softcap was not met.
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        let pool = &ctx.accounts.pool;
        let user_contribution = &mut ctx.accounts.user_contribution;

        require!(pool.is_finalized && pool.is_cancelled, FairLaunchError::RefundNotAvailable);
        require!(!user_contribution.tokens_claimed, FairLaunchError::AlreadyRefunded);
        require!(user_contribution.sol_amount > 0, FairLaunchError::NoContribution);

        let refund_amount = user_contribution.sol_amount;
        user_contribution.sol_amount = 0;
        user_contribution.tokens_claimed = true;

        let pool_name = pool.pool_name.as_bytes();
        let seeds = &[
            b"sol_vault".as_ref(),
            pool_name,
            &[pool.sol_vault_bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sol_vault.to_account_info(),
                to: ctx.accounts.user.to_account_info(),
            },
            signer,
        );
        transfer(cpi_context, refund_amount)?;

        emit!(RefundIssuedEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount: refund_amount,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(pool_name: String)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + LaunchPool::INIT_SPACE,
        seeds = [b"fair_launch", pool_name.as_bytes()],
        bump
    )]
    pub pool: Account<'info, LaunchPool>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint,
        token::authority = pool,
        seeds = [b"token_vault", pool_name.as_bytes()],
        bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    /// CHECK: PDA acting as native SOL accumulator
    #[account(
        init,
        payer = authority,
        space = 0,
        seeds = [b"sol_vault", pool_name.as_bytes()],
        bump
    )]
    pub sol_vault: AccountInfo<'info>,

    #[account(mut)]
    pub authority_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(
        mut,
        seeds = [b"fair_launch", pool.pool_name.as_bytes()],
        bump = pool.bump
    )]
    pub pool: Account<'info, LaunchPool>,

    /// CHECK: Native SOL vault PDA
    #[account(
        mut,
        seeds = [b"sol_vault", pool.pool_name.as_bytes()],
        bump = pool.sol_vault_bump
    )]
    pub sol_vault: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserContribution::INIT_SPACE,
        seeds = [b"contribution", pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_contribution: Account<'info, UserContribution>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizePool<'info> {
    #[account(
        mut,
        seeds = [b"fair_launch", pool.pool_name.as_bytes()],
        bump = pool.bump
    )]
    pub pool: Account<'info, LaunchPool>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(
        seeds = [b"fair_launch", pool.pool_name.as_bytes()],
        bump = pool.bump
    )]
    pub pool: Account<'info, LaunchPool>,

    #[account(
        mut,
        seeds = [b"token_vault", pool.pool_name.as_bytes()],
        bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"contribution", pool.key().as_ref(), user.key().as_ref()],
        bump = user_contribution.bump,
        has_one = user,
        has_one = pool
    )]
    pub user_contribution: Account<'info, UserContribution>,

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
pub struct ClaimRefund<'info> {
    #[account(
        seeds = [b"fair_launch", pool.pool_name.as_bytes()],
        bump = pool.bump
    )]
    pub pool: Account<'info, LaunchPool>,

    /// CHECK: Native SOL vault PDA
    #[account(
        mut,
        seeds = [b"sol_vault", pool.pool_name.as_bytes()],
        bump = pool.sol_vault_bump
    )]
    pub sol_vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"contribution", pool.key().as_ref(), user.key().as_ref()],
        bump = user_contribution.bump,
        has_one = user,
        has_one = pool
    )]
    pub user_contribution: Account<'info, UserContribution>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// DATA STATE & EVENTS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct LaunchPool {
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub token_vault: Pubkey,
    pub sol_vault: Pubkey,
    #[max_len(32)]
    pub pool_name: String,
    pub token_allocation: u64,
    pub min_raise: u64,
    pub max_raise: u64,
    pub total_sol_raised: u64,
    pub start_slot: u64,
    pub end_slot: u64,
    pub max_contribution_per_user: u64,
    pub is_finalized: bool,
    pub is_cancelled: bool,
    pub bump: u8,
    pub sol_vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserContribution {
    pub user: Pubkey,
    pub pool: Pubkey,
    pub sol_amount: u64,
    pub tokens_claimed: bool,
    pub bump: u8,
}

#[event]
pub struct PoolInitializedEvent {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub token_allocation: u64,
    pub min_raise: u64,
    pub max_raise: u64,
    pub start_slot: u64,
    pub end_slot: u64,
}

#[event]
pub struct ContributionMadeEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub total_user_sol: u64,
    pub total_pool_sol: u64,
    pub slot: u64,
}

#[event]
pub struct PoolFinalizedEvent {
    pub pool: Pubkey,
    pub total_sol_raised: u64,
    pub token_allocation: u64,
    pub final_clearing_ratio: f64,
}

#[event]
pub struct PoolCancelledEvent {
    pub pool: Pubkey,
    pub total_sol_raised: u64,
    pub min_raise: u64,
}

#[event]
pub struct TokensClaimedEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RefundIssuedEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum FairLaunchError {
    #[msg("Pool name exceeds maximum length of 32 bytes.")]
    NameTooLong,
    #[msg("Invalid economic parameters: ensure min <= max and min > 0.")]
    InvalidParameters,
    #[msg("Invalid slot configuration: start_slot must precede end_slot.")]
    InvalidWindow,
    #[msg("Token allocation must be non-zero.")]
    ZeroTokenAllocation,
    #[msg("Start slot cannot be in the past.")]
    WindowInPast,
    #[msg("Fair launch pool is currently inactive or completed.")]
    PoolInactive,
    #[msg("Launch has not reached start slot yet.")]
    LaunchNotStarted,
    #[msg("Launch time window has lapsed.")]
    LaunchEnded,
    #[msg("Contribution must be greater than zero.")]
    ZeroContribution,
    #[msg("Contribution exceeds maximum individual allocation allowance.")]
    ExceedsUserCap,
    #[msg("Contribution would exceed total pool maximum cap.")]
    ExceedsMaxRaise,
    #[msg("Mathematical calculation overflow.")]
    MathOverflow,
    #[msg("Launch pool is already finalized.")]
    AlreadyFinalized,
    #[msg("Launch duration still running and cap not hit.")]
    LaunchStillActive,
    #[msg("Pool not yet finalized.")]
    NotFinalized,
    #[msg("Pool was cancelled due to unmet softcap.")]
    PoolCancelled,
    #[msg("User has already executed token claim.")]
    AlreadyClaimed,
    #[msg("No active contribution found for user.")]
    NoContribution,
    #[msg("Refunds only valid if launch pool did not reach softcap.")]
    RefundNotAvailable,
    #[msg("Refund already claimed.")]
    AlreadyRefunded,
}
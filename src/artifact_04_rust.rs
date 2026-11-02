use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("CH1MP1aunchXvL8xGk8xK8vBwFzV8qg2p9vRjNmK9XkQ");

#[program]
pub mod chimp_fair_launch {
    use super::*;

    /// Initialize a new $CHIMP Fair Launch pool with deterministic slot bounds and caps.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        launch_id: u64,
        start_slot: u64,
        end_slot: u64,
        tokens_for_sale: u64,
        min_commit_lamports: u64,
        max_commit_lamports: u64,
    ) -> Result<()> {
        require!(
            start_slot < end_slot,
            FairLaunchError::InvalidSlotRange
        );
        require!(tokens_for_sale > 0, FairLaunchError::ZeroTokenAllocation);
        require!(
            min_commit_lamports <= max_commit_lamports,
            FairLaunchError::InvalidCommitmentLimits
        );

        let clock = Clock::get()?;
        require!(
            start_slot >= clock.slot,
            FairLaunchError::StartSlotInPast
        );

        let pool = &mut ctx.accounts.launch_pool;
        pool.authority = ctx.accounts.authority.key();
        pool.launch_id = launch_id;
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.token_vault = ctx.accounts.token_vault.key();
        pool.sol_vault_bump = ctx.bumps.sol_vault;
        pool.pool_bump = ctx.bumps.launch_pool;
        pool.start_slot = start_slot;
        pool.end_slot = end_slot;
        pool.tokens_for_sale = tokens_for_sale;
        pool.min_commit_lamports = min_commit_lamports;
        pool.max_commit_lamports = max_commit_lamports;
        pool.total_sol_collected = 0;
        pool.total_tokens_claimed = 0;
        pool.is_finalized = false;
        pool.is_cancelled = false;

        // Transfer tokens for the fair launch to escrow vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.authority_token_account.to_account_info(),
            to: ctx.accounts.token_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new(cpi_program, cpi_accounts),
            tokens_for_sale,
        )?;

        emit!(PoolInitializedEvent {
            launch_id,
            authority: pool.authority,
            start_slot,
            end_slot,
            tokens_for_sale,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Commit SOL into the batch auction pool during the active slot window.
    pub fn commit_funds(ctx: Context<CommitFunds>, amount: u64) -> Result<()> {
        let clock = Clock::get()?;
        let pool = &mut ctx.accounts.launch_pool;

        require!(!pool.is_finalized, FairLaunchError::PoolAlreadyFinalized);
        require!(!pool.is_cancelled, FairLaunchError::PoolCancelled);
        require!(
            clock.slot >= pool.start_slot,
            FairLaunchError::CommitWindowNotOpen
        );
        require!(
            clock.slot < pool.end_slot,
            FairLaunchError::CommitWindowClosed
        );
        require!(amount > 0, FairLaunchError::ZeroDeposit);

        let user_commit = &mut ctx.accounts.user_commitment;
        let new_user_total = user_commit
            .lamports_committed
            .checked_add(amount)
            .ok_or(FairLaunchError::NumericalOverflow)?;

        require!(
            new_user_total >= pool.min_commit_lamports,
            FairLaunchError::BelowMinCommitment
        );
        require!(
            new_user_total <= pool.max_commit_lamports,
            FairLaunchError::ExceedsMaxCommitment
        );

        // System transfer SOL from user to program sol_vault PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        // Update accounting
        user_commit.pool = pool.key();
        user_commit.user = ctx.accounts.user.key();
        user_commit.lamports_committed = new_user_total;
        user_commit.tokens_claimed = 0;

        pool.total_sol_collected = pool
            .total_sol_collected
            .checked_add(amount)
            .ok_or(FairLaunchError::NumericalOverflow)?;

        emit!(FundCommittedEvent {
            launch_id: pool.launch_id,
            user: ctx.accounts.user.key(),
            lamports_added: amount,
            total_user_committed: new_user_total,
            total_pool_sol: pool.total_sol_collected,
            slot: clock.slot,
        });

        Ok(())
    }

    /// Finalize clearing parameters deterministically once the end slot is reached.
    pub fn finalize_pool(ctx: Context<FinalizePool>) -> Result<()> {
        let clock = Clock::get()?;
        let pool = &mut ctx.accounts.launch_pool;

        require!(!pool.is_finalized, FairLaunchError::PoolAlreadyFinalized);
        require!(!pool.is_cancelled, FairLaunchError::PoolCancelled);
        require!(
            clock.slot >= pool.end_slot,
            FairLaunchError::CommitWindowStillActive
        );
        require!(
            pool.total_sol_collected > 0,
            FairLaunchError::ZeroTotalCommitments
        );

        pool.is_finalized = true;

        emit!(PoolFinalizedEvent {
            launch_id: pool.launch_id,
            total_sol_collected: pool.total_sol_collected,
            tokens_for_sale: pool.tokens_for_sale,
            finalized_slot: clock.slot,
            clearing_price_lamports_per_token: (pool.total_sol_collected as u128)
                .checked_mul(1_000_000_000)
                .unwrap_or(0)
                .checked_div(pool.tokens_for_sale as u128)
                .unwrap_or(0) as u64,
        });

        Ok(())
    }

    /// Claim tokens pro-rata calculated deterministically from commitment share.
    pub fn claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
        let pool = &ctx.accounts.launch_pool;
        require!(pool.is_finalized, FairLaunchError::PoolNotFinalized);

        let user_commit = &mut ctx.accounts.user_commitment;
        require!(
            user_commit.lamports_committed > 0,
            FairLaunchError::NoCommitmentFound
        );
        require!(
            user_commit.tokens_claimed == 0,
            FairLaunchError::TokensAlreadyClaimed
        );

        // Precise pro-rata arithmetic: user_tokens = (user_sol * tokens_for_sale) / total_sol
        let allocation = (user_commit.lamports_committed as u128)
            .checked_mul(pool.tokens_for_sale as u128)
            .ok_or(FairLaunchError::NumericalOverflow)?
            .checked_div(pool.total_sol_collected as u128)
            .ok_or(FairLaunchError::NumericalOverflow)? as u64;

        require!(allocation > 0, FairLaunchError::ZeroClaimableAllocation);

        user_commit.tokens_claimed = allocation;

        // Sign transfer using LaunchPool PDA seeds
        let launch_id_bytes = pool.launch_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            b"launch_pool",
            launch_id_bytes.as_ref(),
            &[pool.pool_bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.token_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.launch_pool.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, seeds),
            allocation,
        )?;

        emit!(TokensClaimedEvent {
            launch_id: pool.launch_id,
            user: ctx.accounts.user.key(),
            tokens_claimed: allocation,
            slot: Clock::get()?.slot,
        });

        Ok(())
    }

    /// Migrate committed liquidity and reserve tokens to protocol LP vault.
    pub fn migrate_liquidity(ctx: Context<MigrateLiquidity>, migration_amount_sol: u64) -> Result<()> {
        let pool = &ctx.accounts.launch_pool;
        require!(pool.is_finalized, FairLaunchError::PoolNotFinalized);
        require!(
            ctx.accounts.authority.key() == pool.authority,
            FairLaunchError::Unauthorized
        );

        let sol_vault_balance = ctx.accounts.sol_vault.lamports();
        require!(
            migration_amount_sol <= sol_vault_balance,
            FairLaunchError::InsufficientVaultBalance
        );

        // Transfer funds from sol_vault PDA to target liquidity destination
        **ctx.accounts.sol_vault.try_borrow_mut_lamports()? -= migration_amount_sol;
        **ctx.accounts.liquidity_receiver.try_borrow_mut_lamports()? += migration_amount_sol;

        emit!(LiquidityMigratedEvent {
            launch_id: pool.launch_id,
            sol_amount: migration_amount_sol,
            receiver: ctx.accounts.liquidity_receiver.key(),
            slot: Clock::get()?.slot,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account Context Structs
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(launch_id: u64)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = LaunchPool::LEN,
        seeds = [b"launch_pool", launch_id.to_le_bytes().as_ref()],
        bump
    )]
    pub launch_pool: Account<'info, LaunchPool>,

    /// CHECK: Native SOL PDA escrow used to safely hold contributed SOL
    #[account(
        mut,
        seeds = [b"sol_vault", launch_pool.key().as_ref()],
        bump
    )]
    pub sol_vault: AccountInfo<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint,
        token::authority = launch_pool,
        seeds = [b"token_vault", launch_pool.key().as_ref()],
        bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = authority_token_account.mint == token_mint.key(),
        constraint = authority_token_account.owner == authority.key()
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CommitFunds<'info> {
    #[account(mut)]
    pub launch_pool: Account<'info, LaunchPool>,

    /// CHECK: Native SOL PDA escrow
    #[account(
        mut,
        seeds = [b"sol_vault", launch_pool.key().as_ref()],
        bump = launch_pool.sol_vault_bump
    )]
    pub sol_vault: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = UserCommitment::LEN,
        seeds = [b"commitment", launch_pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_commitment: Account<'info, UserCommitment>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizePool<'info> {
    #[account(mut)]
    pub launch_pool: Account<'info, LaunchPool>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(mut)]
    pub launch_pool: Account<'info, LaunchPool>,

    #[account(
        mut,
        seeds = [b"token_vault", launch_pool.key().as_ref()],
        bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"commitment", launch_pool.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = user_commitment.user == user.key()
    )]
    pub user_commitment: Account<'info, UserCommitment>,

    #[account(
        mut,
        constraint = user_token_account.mint == launch_pool.token_mint,
        constraint = user_token_account.owner == user.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MigrateLiquidity<'info> {
    #[account(
        mut,
        has_one = authority
    )]
    pub launch_pool: Account<'info, LaunchPool>,

    /// CHECK: Native SOL Escrow PDA
    #[account(
        mut,
        seeds = [b"sol_vault", launch_pool.key().as_ref()],
        bump = launch_pool.sol_vault_bump
    )]
    pub sol_vault: AccountInfo<'info>,

    /// CHECK: Target liquidity receiver (e.g., Raydium Pool Authority / Protocol Safe)
    #[account(mut)]
    pub liquidity_receiver: AccountInfo<'info>,

    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// State Accounts & Struct Specifications
// ---------------------------------------------------------------------------

#[account]
pub struct LaunchPool {
    pub authority: Pubkey,          // 32
    pub launch_id: u64,             // 8
    pub token_mint: Pubkey,         // 32
    pub token_vault: Pubkey,        // 32
    pub sol_vault_bump: u8,         // 1
    pub pool_bump: u8,              // 1
    pub start_slot: u64,            // 8
    pub end_slot: u64,              // 8
    pub tokens_for_sale: u64,       // 8
    pub min_commit_lamports: u64,   // 8
    pub max_commit_lamports: u64,   // 8
    pub total_sol_collected: u64,   // 8
    pub total_tokens_claimed: u64,  // 8
    pub is_finalized: bool,         // 1
    pub is_cancelled: bool,         // 1
}

impl LaunchPool {
    pub const LEN: usize = 8 + 32 + 8 + 32 + 32 + 1 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 64;
}

#[account]
pub struct UserCommitment {
    pub pool: Pubkey,               // 32
    pub user: Pubkey,               // 32
    pub lamports_committed: u64,    // 8
    pub tokens_claimed: u64,        // 8
}

impl UserCommitment {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 32;
}

// ---------------------------------------------------------------------------
// Protocol Events
// ---------------------------------------------------------------------------

#[event]
pub struct PoolInitializedEvent {
    pub launch_id: u64,
    pub authority: Pubkey,
    pub start_slot: u64,
    pub end_slot: u64,
    pub tokens_for_sale: u64,
    pub timestamp: i64,
}

#[event]
pub struct FundCommittedEvent {
    pub launch_id: u64,
    pub user: Pubkey,
    pub lamports_added: u64,
    pub total_user_committed: u64,
    pub total_pool_sol: u64,
    pub slot: u64,
}

#[event]
pub struct PoolFinalizedEvent {
    pub launch_id: u64,
    pub total_sol_collected: u64,
    pub tokens_for_sale: u64,
    pub finalized_slot: u64,
    pub clearing_price_lamports_per_token: u64,
}

#[event]
pub struct TokensClaimedEvent {
    pub launch_id: u64,
    pub user: Pubkey,
    pub tokens_claimed: u64,
    pub slot: u64,
}

#[event]
pub struct LiquidityMigratedEvent {
    pub launch_id: u64,
    pub sol_amount: u64,
    pub receiver: Pubkey,
    pub slot: u64,
}

// ---------------------------------------------------------------------------
// Custom Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum FairLaunchError {
    #[msg("Invalid slot configuration: start_slot must be strictly lower than end_slot.")]
    InvalidSlotRange,
    #[msg("Tokens allocated for sale must be greater than zero.")]
    ZeroTokenAllocation,
    #[msg("Invalid commitment limit bounds: min must be <= max.")]
    InvalidCommitmentLimits,
    #[msg("Start slot cannot be in the past.")]
    StartSlotInPast,
    #[msg("Pool has already been finalized.")]
    PoolAlreadyFinalized,
    #[msg("Pool has been cancelled by authority.")]
    PoolCancelled,
    #[msg("Commit window is not yet active.")]
    CommitWindowNotOpen,
    #[msg("Commit window has elapsed.")]
    CommitWindowClosed,
    #[msg("Deposit amount must be greater than zero lamports.")]
    ZeroDeposit,
    #[msg("Total user commitment falls below minimum limit.")]
    BelowMinCommitment,
    #[msg("Total user commitment exceeds maximum allowed limit.")]
    ExceedsMaxCommitment,
    #[msg("Mathematical calculation caused an arithmetic overflow.")]
    NumericalOverflow,
    #[msg("Commitment window is still active; cannot finalize yet.")]
    CommitWindowStillActive,
    #[msg("Zero funds were committed to the pool.")]
    ZeroTotalCommitments,
    #[msg("Pool must be finalized prior to execution.")]
    PoolNotFinalized,
    #[msg("No active user commitment found for this account.")]
    NoCommitmentFound,
    #[msg("Allocated tokens have already been claimed.")]
    TokensAlreadyClaimed,
    #[msg("Claimable token allocation calculated to zero.")]
    ZeroClaimableAllocation,
    #[msg("Signer is unauthorized to perform this management instruction.")]
    Unauthorized,
    #[msg("Requested migration exceeds current vault lamport balance.")]
    InsufficientVaultBalance,
}
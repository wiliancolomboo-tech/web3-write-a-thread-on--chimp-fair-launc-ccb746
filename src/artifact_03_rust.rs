use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

declare_id!("Chimp11111111111111111111111111111111111111");

#[program]
pub mod chimp_launch {
    use super::*;

    pub fn initialize_launch(
        ctx: Context<InitializeLaunch>,
        total_tokens_allocated: u64,
        soft_cap_lamports: u64,
        hard_cap_lamports: u64,
        start_ts: i64,
        end_ts: i64,
    ) -> Result<()> {
        let launch = &mut ctx.accounts.launch_state;
        let clock = Clock::get()?;

        require!(start_ts >= clock.unix_timestamp, LaunchError::InvalidStartTime);
        require!(end_ts > start_ts, LaunchError::InvalidEndTime);
        require!(hard_cap_lamports > soft_cap_lamports, LaunchError::InvalidCaps);
        require!(total_tokens_allocated > 0, LaunchError::ZeroTokens);

        launch.authority = ctx.accounts.authority.key();
        launch.token_mint = ctx.accounts.token_mint.key();
        launch.vault_token_account = ctx.accounts.vault_token_account.key();
        launch.total_tokens_allocated = total_tokens_allocated;
        launch.soft_cap_lamports = soft_cap_lamports;
        launch.hard_cap_lamports = hard_cap_lamports;
        launch.total_lamports_deposited = 0;
        launch.start_ts = start_ts;
        launch.end_ts = end_ts;
        launch.is_finalized = false;
        launch.is_cancelled = false;
        launch.bump = ctx.bumps.launch_state;
        launch.vault_bump = ctx.bumps.vault_authority;

        // Escrow the fair launch tokens from authority into protocol vault
        let cpi_accounts = SplTransfer {
            from: ctx.accounts.authority_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new(cpi_program, cpi_accounts),
            total_tokens_allocated,
        )?;

        emit!(LaunchInitializedEvent {
            launch: launch.key(),
            token_mint: launch.token_mint,
            total_tokens_allocated,
            soft_cap_lamports,
            hard_cap_lamports,
            start_ts,
            end_ts,
        });

        Ok(())
    }

    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        let clock = Clock::get()?;
        let launch = &mut ctx.accounts.launch_state;
        let user_entry = &mut ctx.accounts.user_contribution;

        require!(!launch.is_finalized, LaunchError::LaunchFinalized);
        require!(!launch.is_cancelled, LaunchError::LaunchCancelled);
        require!(clock.unix_timestamp >= launch.start_ts, LaunchError::LaunchNotStarted);
        require!(clock.unix_timestamp <= launch.end_ts, LaunchError::LaunchEnded);
        require!(amount > 0, LaunchError::ZeroDeposit);

        let new_total = launch
            .total_lamports_deposited
            .checked_add(amount)
            .ok_or(LaunchError::MathOverflow)?;

        require!(new_total <= launch.hard_cap_lamports, LaunchError::HardCapExceeded);

        // Transfer SOL from contributor to launch state escrow PDA
        let cpi_accounts = Transfer {
            from: ctx.accounts.user.to_account_info(),
            to: ctx.accounts.vault_sol_escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.system_program.to_account_info();
        transfer(CpiContext::new(cpi_program, cpi_accounts), amount)?;

        // Update state
        launch.total_lamports_deposited = new_total;

        if user_entry.lamports_contributed == 0 {
            user_entry.user = ctx.accounts.user.key();
            user_entry.launch = launch.key();
            user_entry.has_claimed = false;
            user_entry.bump = ctx.bumps.user_contribution;
        }

        user_entry.lamports_contributed = user_entry
            .lamports_contributed
            .checked_add(amount)
            .ok_or(LaunchError::MathOverflow)?;

        emit!(SolDepositedEvent {
            launch: launch.key(),
            user: ctx.accounts.user.key(),
            amount,
            user_total: user_entry.lamports_contributed,
            launch_total: launch.total_lamports_deposited,
        });

        Ok(())
    }

    pub fn finalize_launch(ctx: Context<FinalizeLaunch>) -> Result<()> {
        let clock = Clock::get()?;
        let launch = &mut ctx.accounts.launch_state;

        require!(!launch.is_finalized, LaunchError::AlreadyFinalized);
        require!(!launch.is_cancelled, LaunchError::LaunchCancelled);

        // Launch is eligible for finalization if time expired OR hard cap hit
        let time_expired = clock.unix_timestamp > launch.end_ts;
        let hard_cap_hit = launch.total_lamports_deposited >= launch.hard_cap_lamports;
        require!(time_expired || hard_cap_hit, LaunchError::ConditionsNotMet);

        if launch.total_lamports_deposited < launch.soft_cap_lamports {
            launch.is_cancelled = true;
            emit!(LaunchFailedSoftCapEvent {
                launch: launch.key(),
                total_deposited: launch.total_lamports_deposited,
                soft_cap: launch.soft_cap_lamports,
            });
            return Ok(());
        }

        launch.is_finalized = true;

        emit!(LaunchFinalizedSuccessEvent {
            launch: launch.key(),
            total_lamports: launch.total_lamports_deposited,
            tokens_allocated: launch.total_tokens_allocated,
        });

        Ok(())
    }

    pub fn claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
        let launch = &ctx.accounts.launch_state;
        let user_entry = &mut ctx.accounts.user_contribution;

        require!(launch.is_finalized, LaunchError::NotFinalized);
        require!(!launch.is_cancelled, LaunchError::LaunchCancelled);
        require!(!user_entry.has_claimed, LaunchError::AlreadyClaimed);
        require!(user_entry.lamports_contributed > 0, LaunchError::NoContribution);

        // Pro-rata mathematical distribution:
        // claim_amount = (user_lamports * total_tokens_allocated) / total_lamports_deposited
        let token_amount = (user_entry.lamports_contributed as u128)
            .checked_mul(launch.total_tokens_allocated as u128)
            .ok_or(LaunchError::MathOverflow)?
            .checked_div(launch.total_lamports_deposited as u128)
            .ok_or(LaunchError::MathOverflow)? as u64;

        user_entry.has_claimed = true;

        let seeds = &[
            b"vault_authority".as_ref(),
            launch.to_account_info().key.as_ref(),
            &[launch.vault_bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = SplTransfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();

        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer),
            token_amount,
        )?;

        emit!(TokensClaimedEvent {
            launch: launch.key(),
            user: user_entry.user,
            tokens_claimed: token_amount,
        });

        Ok(())
    }

    pub fn refund_sol(ctx: Context<RefundSol>) -> Result<()> {
        let launch = &ctx.accounts.launch_state;
        let user_entry = &mut ctx.accounts.user_contribution;

        require!(launch.is_cancelled, LaunchError::NotCancelled);
        require!(!user_entry.has_claimed, LaunchError::AlreadyClaimed);
        require!(user_entry.lamports_contributed > 0, LaunchError::NoContribution);

        let refund_amount = user_entry.lamports_contributed;
        user_entry.lamports_contributed = 0;
        user_entry.has_claimed = true;

        **ctx.accounts.vault_sol_escrow.try_borrow_mut_lamports()? -= refund_amount;
        **ctx.accounts.user.try_borrow_mut_lamports()? += refund_amount;

        emit!(SolRefundedEvent {
            launch: launch.key(),
            user: ctx.accounts.user.key(),
            lamports_refunded: refund_amount,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Context Accounts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeLaunch<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + LaunchState::INIT_SPACE,
        seeds = [b"launch_state", token_mint.key().as_ref()],
        bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK: PDA that holds protocol authority for token vaults
    #[account(
        seeds = [b"vault_authority", launch_state.key().as_ref()],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = authority_token_account.mint == token_mint.key(),
        constraint = authority_token_account.owner == authority.key()
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint,
        token::authority = vault_authority,
        seeds = [b"token_vault", launch_state.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(
        mut,
        seeds = [b"launch_state", launch_state.token_mint.as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK: Native lamport escrow PDA
    #[account(
        mut,
        seeds = [b"sol_escrow", launch_state.key().as_ref()],
        bump
    )]
    pub vault_sol_escrow: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserContribution::INIT_SPACE,
        seeds = [b"user_entry", launch_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_contribution: Account<'info, UserContribution>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeLaunch<'info> {
    #[account(
        mut,
        seeds = [b"launch_state", launch_state.token_mint.as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(
        seeds = [b"launch_state", launch_state.token_mint.as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK: Vault authority PDA
    #[account(
        seeds = [b"vault_authority", launch_state.key().as_ref()],
        bump = launch_state.vault_bump
    )]
    pub vault_authority: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"token_vault", launch_state.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"user_entry", launch_state.key().as_ref(), user.key().as_ref()],
        bump = user_contribution.bump,
        constraint = user_contribution.user == user.key()
    )]
    pub user_contribution: Account<'info, UserContribution>,

    #[account(
        mut,
        constraint = user_token_account.mint == launch_state.token_mint,
        constraint = user_token_account.owner == user.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundSol<'info> {
    #[account(
        seeds = [b"launch_state", launch_state.token_mint.as_ref()],
        bump = launch_state.bump
    )]
    pub launch_state: Account<'info, LaunchState>,

    /// CHECK: Native lamport escrow PDA
    #[account(
        mut,
        seeds = [b"sol_escrow", launch_state.key().as_ref()],
        bump
    )]
    pub vault_sol_escrow: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"user_entry", launch_state.key().as_ref(), user.key().as_ref()],
        bump = user_contribution.bump,
        constraint = user_contribution.user == user.key()
    )]
    pub user_contribution: Account<'info, UserContribution>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// State Structures
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct LaunchState {
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub total_tokens_allocated: u64,
    pub soft_cap_lamports: u64,
    pub hard_cap_lamports: u64,
    pub total_lamports_deposited: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub is_finalized: bool,
    pub is_cancelled: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserContribution {
    pub user: Pubkey,
    pub launch: Pubkey,
    pub lamports_contributed: u64,
    pub has_claimed: bool,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// Events & Errors
// -----------------------------------------------------------------------------

#[event]
pub struct LaunchInitializedEvent {
    pub launch: Pubkey,
    pub token_mint: Pubkey,
    pub total_tokens_allocated: u64,
    pub soft_cap_lamports: u64,
    pub hard_cap_lamports: u64,
    pub start_ts: i64,
    pub end_ts: i64,
}

#[event]
pub struct SolDepositedEvent {
    pub launch: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub user_total: u64,
    pub launch_total: u64,
}

#[event]
pub struct LaunchFinalizedSuccessEvent {
    pub launch: Pubkey,
    pub total_lamports: u64,
    pub tokens_allocated: u64,
}

#[event]
pub struct LaunchFailedSoftCapEvent {
    pub launch: Pubkey,
    pub total_deposited: u64,
    pub soft_cap: u64,
}

#[event]
TokensClaimedEvent {
    pub launch: Pubkey,
    pub user: Pubkey,
    pub tokens_claimed: u64,
}

#[event]
pub struct SolRefundedEvent {
    pub launch: Pubkey,
    pub user: Pubkey,
    pub lamports_refunded: u64,
}

#[error_code]
pub enum LaunchError {
    #[msg("Invalid start timestamp. Must be in the future.")]
    InvalidStartTime,
    #[msg("Invalid end timestamp. Must occur after start timestamp.")]
    InvalidEndTime,
    #[msg("Invalid caps. Hard cap must strictly exceed soft cap.")]
    InvalidCaps,
    #[msg("Token allocation must be greater than zero.")]
    ZeroTokens,
    #[msg("Launch has already been finalized.")]
    LaunchFinalized,
    #[msg("Launch was cancelled.")]
    LaunchCancelled,
    #[msg("Launch epoch has not started yet.")]
    LaunchNotStarted,
    #[msg("Launch epoch has expired.")]
    LaunchEnded,
    #[msg("Deposit amount must be non-zero.")]
    ZeroDeposit,
    #[msg("Deposit exceeds maximum hard cap.")]
    HardCapExceeded,
    #[msg("Launch conditions for finalization are not satisfied.")]
    ConditionsNotMet,
    #[msg("Launch is already finalized.")]
    AlreadyFinalized,
    #[msg("Launch has not reached finalization yet.")]
    NotFinalized,
    #[msg("Launch is not cancelled.")]
    NotCancelled,
    #[msg("Allocation already claimed by user.")]
    AlreadyClaimed,
    #[msg("User has no recorded contribution.")]
    NoContribution,
    #[msg("Arithmetic overflow occurred.")]
    MathOverflow,
}
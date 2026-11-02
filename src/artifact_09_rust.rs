use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use crate::state::{LaunchPool, UserRecord, LaunchPhase};
use crate::errors::FairLaunchError;
use crate::events::DepositEvent;

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_pool", launch_pool.token_mint.as_ref()],
        bump = launch_pool.bump,
        has_one = sol_vault
    )]
    pub launch_pool: Account<'info, LaunchPool>,

    /// CHECK: Sol vault verified by seed in pool state
    #[account(
        mut,
        seeds = [b"sol_vault", launch_pool.key().as_ref()],
        bump = launch_pool.sol_vault_bump
    )]
    pub sol_vault: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserRecord::INIT_SPACE,
        seeds = [b"user_record", launch_pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_record: Account<'info, UserRecord>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.launch_pool;
    let user_rec = &mut ctx.accounts.user_record;

    require!(pool.phase == LaunchPhase::Live, FairLaunchError::LaunchEnded);
    require!(now >= pool.start_time, FairLaunchError::LaunchNotStarted);
    require!(now <= pool.end_time, FairLaunchError::LaunchEnded);
    require!(amount >= pool.min_deposit, FairLaunchError::DepositTooLow);

    let new_user_total = user_rec.deposited_amount.checked_add(amount)
        .ok_or(FairLaunchError::MathOverflow)?;
    require!(
        new_user_total <= pool.max_deposit_per_wallet,
        FairLaunchError::MaxDepositExceeded
    );

    let new_pool_sol = pool.total_sol_deposited.checked_add(amount)
        .ok_or(FairLaunchError::MathOverflow)?;
    require!(new_pool_sol <= pool.hard_cap, FairLaunchError::HardCapExceeded);

    if user_rec.deposited_amount == 0 {
        pool.contributor_count = pool.contributor_count.checked_add(1)
            .ok_or(FairLaunchError::MathOverflow)?;
        user_rec.contributor = ctx.accounts.user.key();
        user_rec.pool = pool.key();
        user_rec.has_claimed = false;
        user_rec.bump = ctx.bumps.user_record;
    }

    user_rec.deposited_amount = new_user_total;
    pool.total_sol_deposited = new_pool_sol;

    let cpi_context = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user.to_account_info(),
            to: ctx.accounts.sol_vault.to_account_info(),
        },
    );
    transfer(cpi_context, amount)?;

    emit!(DepositEvent {
        pool: pool.key(),
        user: ctx.accounts.user.key(),
        amount,
        total_pool_sol: new_pool_sol,
        timestamp: now,
    });

    Ok(())
}
use anchor_lang::prelude::*;
use crate::state::{LaunchPool, LaunchPhase};
use crate::errors::FairLaunchError;
use crate::events::PoolFinalizedEvent;

#[derive(Accounts)]
pub struct FinalizePool<'info> {
    #[account(
        mut,
        has_one = authority
    )]
    pub launch_pool: Account<'info, LaunchPool>,
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<FinalizePool>) -> Result<()> {
    let pool = &mut ctx.accounts.launch_pool;
    let now = Clock::get()?.unix_timestamp;

    require!(
        now > pool.end_time || pool.total_sol_deposited == pool.hard_cap,
        FairLaunchError::LaunchStillActive
    );
    require!(pool.phase == LaunchPhase::Live, FairLaunchError::InvalidParameters);

    if pool.total_sol_deposited >= pool.soft_cap {
        pool.phase = LaunchPhase::FinalizedSuccess;
        emit!(PoolFinalizedEvent {
            pool: pool.key(),
            successful: true,
            total_sol_collected: pool.total_sol_deposited,
            total_tokens_sold: pool.total_tokens_for_sale,
            timestamp: now,
        });
    } else {
        pool.phase = LaunchPhase::FinalizedRefund;
        emit!(PoolFinalizedEvent {
            pool: pool.key(),
            successful: false,
            total_sol_collected: pool.total_sol_deposited,
            total_tokens_sold: 0,
            timestamp: now,
        });
    }

    Ok(())
}
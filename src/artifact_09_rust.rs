use anchor_lang::prelude::*;
use crate::state::LaunchPool;
use crate::errors::FairLaunchError;

#[derive(Accounts)]
pub struct FinalizePool<'info> {
    #[account(
        mut,
        seeds = [b"chimp_pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, LaunchPool>,

    /// Signer finalizing pool (permissionless once slot criteria satisfied)
    pub caller: Signer<'info>,
}

pub fn handler(ctx: Context<FinalizePool>) -> Result<()> {
    let current_slot = Clock::get()?.slot;
    let pool = &mut ctx.accounts.pool;

    require!(current_slot > pool.end_slot, FairLaunchError::EpochNotEnded);
    require!(!pool.is_finalized, FairLaunchError::AlreadyFinalized);

    pool.is_finalized = true;
    if pool.total_sol_deposited >= pool.soft_cap_lamports {
        pool.is_successful = true;
    } else {
        pool.is_successful = false;
    }

    Ok(())
}
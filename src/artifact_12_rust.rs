use anchor_lang::prelude::*;
use crate::state::{LaunchPool, UserRecord, LaunchPhase};
use crate::errors::FairLaunchError;
use crate::events::RefundClaimedEvent;

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_pool", launch_pool.token_mint.as_ref()],
        bump = launch_pool.bump,
        has_one = sol_vault
    )]
    pub launch_pool: Account<'info, LaunchPool>,

    /// CHECK: Sol vault validated by seed and PDA signer
    #[account(
        mut,
        seeds = [b"sol_vault", launch_pool.key().as_ref()],
        bump = launch_pool.sol_vault_bump
    )]
    pub sol_vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"user_record", launch_pool.key().as_ref(), user.key().as_ref()],
        bump = user_record.bump,
        has_one = user,
        has_one = pool
    )]
    pub user_record: Account<'info, UserRecord>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Refund>) -> Result<()> {
    let pool = &ctx.accounts.launch_pool;
    let user_record = &mut ctx.accounts.user_record;

    require!(pool.phase == LaunchPhase::FinalizedRefund, FairLaunchError::RefundNotPermitted);
    require!(!user_record.has_claimed, FairLaunchError::AlreadyClaimed);
    require!(user_record.deposited_amount > 0, FairLaunchError::ZeroBalance);

    let refund_amount = user_record.deposited_amount;
    user_record.deposited_amount = 0;
    user_record.has_claimed = true;

    **ctx.accounts.sol_vault.try_borrow_mut_lamports()? = ctx
        .accounts
        .sol_vault
        .lamports()
        .checked_sub(refund_amount)
        .ok_or(FairLaunchError::MathOverflow)?;

    **ctx.accounts.user.try_borrow_mut_lamports()? = ctx
        .accounts
        .user
        .lamports()
        .checked_add(refund_amount)
        .ok_or(FairLaunchError::MathOverflow)?;

    emit!(RefundClaimedEvent {
        pool: pool.key(),
        user: ctx.accounts.user.key(),
        sol_refunded: refund_amount,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
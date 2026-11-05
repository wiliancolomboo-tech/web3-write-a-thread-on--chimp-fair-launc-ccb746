use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use crate::state::{LaunchPool, ContributionReceipt};
use crate::errors::FairLaunchError;

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(
        mut,
        seeds = [b"chimp_pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, LaunchPool>,

    /// CHECK: Native SOL Escrow Vault PDA verified by seeds
    #[account(
        mut,
        seeds = [b"sol_vault", pool.key().as_ref()],
        bump
    )]
    pub sol_vault: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = ContributionReceipt::LEN,
        seeds = [b"receipt", pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, ContributionReceipt>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Contribute>, amount_lamports: u64) -> Result<()> {
    require!(amount_lamports > 0, FairLaunchError::ZeroContribution);
    
    let current_slot = Clock::get()?.slot;
    let pool = &mut ctx.accounts.pool;

    require!(current_slot >= pool.start_slot, FairLaunchError::LaunchNotStarted);
    require!(current_slot <= pool.end_slot, FairLaunchError::LaunchEnded);
    require!(!pool.is_finalized, FairLaunchError::AlreadyFinalized);

    // Transfer SOL from user to the SOL vault PDA
    let cpi_context = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user.to_account_info(),
            to: ctx.accounts.sol_vault.to_account_info(),
        },
    );
    transfer(cpi_context, amount_lamports)?;

    // Update global and user accounting
    pool.total_sol_deposited = pool
        .total_sol_deposited
        .checked_add(amount_lamports)
        .ok_or(FairLaunchError::MathOverflow)?;

    let receipt = &mut ctx.accounts.receipt;
    if receipt.lamports_contributed == 0 {
        receipt.user = ctx.accounts.user.key();
        receipt.pool = pool.key();
        receipt.has_claimed = false;
        receipt.bump = ctx.bumps.receipt;
    }

    receipt.lamports_contributed = receipt
        .lamports_contributed
        .checked_add(amount_lamports)
        .ok_or(FairLaunchError::MathOverflow)?;

    Ok(())
}
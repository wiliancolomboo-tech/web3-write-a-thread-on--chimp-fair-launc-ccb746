use anchor_lang::prelude::*;
use crate::state::{LaunchConfig, LaunchStatus, UserReceipt, LAUNCH_SEED, USER_RECEIPT_SEED, VAULT_SEED};
use crate::errors::FairLaunchError;

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    #[account(
        mut,
        seeds = [LAUNCH_SEED, launch_config.token_mint.as_ref()],
        bump = launch_config.bump,
        has_one = sol_vault
    )]
    pub launch_config: Account<'info, LaunchConfig>,

    #[account(
        mut,
        seeds = [VAULT_SEED, launch_config.key().as_ref()],
        bump = launch_config.sol_vault_bump
    )]
    /// CHECK: Checked via PDA seeds
    pub sol_vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [USER_RECEIPT_SEED, launch_config.key().as_ref(), contributor.key().as_ref()],
        bump = user_receipt.bump,
        has_one = contributor
    )]
    pub user_receipt: Account<'info, UserReceipt>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Refund>) -> Result<()> {
    let config = &ctx.accounts.launch_config;
    let receipt = &mut ctx.accounts.user_receipt;

    require!(config.status == LaunchStatus::Failed, FairLaunchError::SoftCapReached);
    require!(!receipt.claimed, FairLaunchError::AlreadyClaimed);
    let refund_amount = receipt.deposited_lamports;
    require!(refund_amount > 0, FairLaunchError::ZeroContribution);

    receipt.deposited_lamports = 0;
    receipt.claimed = true;

    // Refund lamports from sol_vault to contributor directly
    let config_key = config.key();
    let sol_vault_seeds = &[
        VAULT_SEED,
        config_key.as_ref(),
        &[config.sol_vault_bump],
    ];

    **ctx.accounts.sol_vault.try_borrow_mut_lamports()? = ctx
        .accounts.sol_vault
        .lamports()
        .checked_sub(refund_amount)
        .ok_or(FairLaunchError::MathOverflow)?;

    **ctx.accounts.contributor.try_borrow_mut_lamports()? = ctx
        .accounts.contributor
        .lamports()
        .checked_add(refund_amount)
        .ok_or(FairLaunchError::MathOverflow)?;

    msg!("Refunded {} lamports to {}", refund_amount, receipt.contributor);
    Ok(())
}
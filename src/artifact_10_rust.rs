use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::{LaunchPool, ContributionReceipt};
use crate::errors::FairLaunchError;

#[derive(Accounts)]
pub struct ClaimTokensAndRefund<'info> {
    #[account(
        mut,
        seeds = [b"chimp_pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, LaunchPool>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"token_vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    /// CHECK: Program owned native SOL escrow vault PDA
    #[account(
        mut,
        seeds = [b"sol_vault", pool.key().as_ref()],
        bump
    )]
    pub sol_vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"receipt", pool.key().as_ref(), user.key().as_ref()],
        bump = receipt.bump,
        constraint = receipt.user == user.key(),
        constraint = receipt.pool == pool.key()
    )]
    pub receipt: Account<'info, ContributionReceipt>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = token_mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimTokensAndRefund>) -> Result<()> {
    let pool = &ctx.accounts.pool;
    let receipt = &mut ctx.accounts.receipt;

    require!(pool.is_finalized, FairLaunchError::NotFinalized);
    require!(!receipt.has_claimed, FairLaunchError::AlreadyClaimed);

    receipt.has_claimed = true;
    let user_contrib = receipt.lamports_contributed as u128;

    // CASE 1: Pool failed soft-cap -> 100% SOL Refund, 0 Tokens
    if !pool.is_successful {
        let refund_amount = receipt.lamports_contributed;
        **ctx.accounts.sol_vault.try_borrow_mut_lamports()? -= refund_amount;
        **ctx.accounts.user.try_borrow_mut_lamports()? += refund_amount;
        return Ok(());
    }

    // CASE 2: Pool Succeeded -> Calculate Pro-Rata Share and Overflow Refund
    let total_sol = pool.total_sol_deposited as u128;
    let hard_cap = pool.hard_cap_lamports as u128;
    let total_chimp = pool.total_tokens_allocated as u128;

    let (token_payout, sol_refund) = if total_sol <= hard_cap {
        // Under or equal to hard cap: No refund, proportional token share
        let tokens = (user_contrib * total_chimp) / total_sol;
        (tokens as u64, 0u64)
    } else {
        // Hard-cap exceeded: Scaled token share based on hard-cap contribution + pro-rata refund
        let effective_user_sol = (user_contrib * hard_cap) / total_sol;
        let excess_user_sol = user_contrib - effective_user_sol;
        let tokens = (effective_user_sol * total_chimp) / hard_cap;
        (tokens as u64, excess_user_sol as u64)
    };

    // Distribute $CHIMP Tokens via PDA Signer
    if token_payout > 0 {
        let pool_mint = pool.token_mint;
        let pool_bump = pool.bump;
        let seeds: &[&[&[u8]]] = &[&[
            b"chimp_pool",
            pool_mint.as_ref(),
            &[pool_bump],
        ]];

        let cpi_transfer = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            seeds,
        );
        token::transfer(cpi_transfer, token_payout)?;
    }

    // Refund excess SOL lamports if Hard Cap was exceeded
    if sol_refund > 0 {
        **ctx.accounts.sol_vault.try_borrow_mut_lamports()? -= sol_refund;
        **ctx.accounts.user.try_borrow_mut_lamports()? += sol_refund;
    }

    Ok(())
}
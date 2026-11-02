use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{LaunchPool, UserContribution};
use crate::errors::FairLaunchError;
use crate::events::TokensClaimedEvent;

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_pool", pool.token_mint.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, LaunchPool>,

    #[account(
        mut,
        seeds = [b"user_contribution", pool.key().as_ref(), user.key().as_ref()],
        bump = user_contribution.bump,
        constraint = user_contribution.user == user.key() @ FairLaunchError::Unauthorized
    )]
    pub user_contribution: Account<'info, UserContribution>,

    #[account(
        mut,
        constraint = pool_token_vault.key() == pool.pool_token_vault
    )]
    pub pool_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == pool.token_mint
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
    let pool = &ctx.accounts.pool;
    let user_rec = &mut ctx.accounts.user_contribution;

    require!(pool.is_finalized, FairLaunchError::PoolNotFinalized);
    require!(!user_rec.claimed, FairLaunchError::TokensAlreadyClaimed);
    require!(user_rec.lamports_contributed > 0, FairLaunchError::ZeroAllocation);

    // allocation = (user_contribution * total_tokens_for_sale) / total_sol_raised
    let token_allocation = (user_rec.lamports_contributed as u128)
        .checked_mul(pool.total_tokens_for_sale as u128)
        .ok_or(FairLaunchError::MathOverflow)?
        .checked_div(pool.total_sol_raised as u128)
        .ok_or(FairLaunchError::MathOverflow)? as u64;

    user_rec.claimed = true;

    let mint_key = pool.token_mint;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"launch_pool",
        mint_key.as_ref(),
        &[pool.bump],
    ]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.pool_token_vault.to_account_info(),
        to: ctx.accounts.user_token_account.to_account_info(),
        authority: ctx.accounts.pool.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    token::transfer(cpi_ctx, token_allocation)?;

    emit!(TokensClaimedEvent {
        pool: pool.key(),
        user: ctx.accounts.user.key(),
        token_amount: token_allocation,
        excess_sol_refunded: 0,
    });

    Ok(())
}
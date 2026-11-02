use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::{LaunchPool, UserRecord, LaunchPhase};
use crate::errors::FairLaunchError;
use crate::events::TokensClaimedEvent;

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"launch_pool", launch_pool.token_mint.as_ref()],
        bump = launch_pool.bump,
        has_one = token_vault,
        has_one = token_mint
    )]
    pub launch_pool: Account<'info, LaunchPool>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"token_vault", launch_pool.key().as_ref()],
        bump = launch_pool.token_vault_bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"user_record", launch_pool.key().as_ref(), user.key().as_ref()],
        bump = user_record.bump,
        has_one = user,
        has_one = pool
    )]
    pub user_record: Account<'info, UserRecord>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == token_mint.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimTokens>) -> Result<()> {
    let pool = &ctx.accounts.launch_pool;
    let user_record = &mut ctx.accounts.user_record;

    require!(pool.phase == LaunchPhase::FinalizedSuccess, FairLaunchError::PoolNotFinalized);
    require!(!user_record.has_claimed, FairLaunchError::AlreadyClaimed);
    require!(user_record.deposited_amount > 0, FairLaunchError::ZeroBalance);

    // Allocation calculation:
    // (user_sol_deposited * total_tokens_for_sale) / total_sol_deposited
    let user_tokens = (user_record.deposited_amount as u128)
        .checked_mul(pool.total_tokens_for_sale as u128)
        .ok_or(FairLaunchError::MathOverflow)?
        .checked_div(pool.total_sol_deposited as u128)
        .ok_or(FairLaunchError::MathOverflow)? as u64;

    user_record.has_claimed = true;

    let pool_key = pool.key();
    let token_vault_bump = pool.token_vault_bump;
    let seeds = &[
        b"token_vault",
        pool_key.as_ref(),
        &[token_vault_bump],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.token_vault.to_account_info(),
        to: ctx.accounts.user_token_account.to_account_info(),
        authority: ctx.accounts.token_vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    token::transfer(cpi_ctx, user_tokens)?;

    emit!(TokensClaimedEvent {
        pool: pool.key(),
        user: ctx.accounts.user.key(),
        tokens_received: user_tokens,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
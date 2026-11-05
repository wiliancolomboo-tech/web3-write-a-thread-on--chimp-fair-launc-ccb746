use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::LaunchPool;
use crate::errors::FairLaunchError;

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = LaunchPool::LEN,
        seeds = [b"chimp_pool", token_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, LaunchPool>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [b"token_vault", pool.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = pool,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = authority_token_account.mint == token_mint.key(),
        constraint = authority_token_account.owner == authority.key()
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializePool>,
    total_tokens_allocated: u64,
    start_slot: u64,
    end_slot: u64,
    soft_cap_lamports: u64,
    hard_cap_lamports: u64,
) -> Result<()> {
    require!(start_slot < end_slot, FairLaunchError::InvalidSlotRange);
    require!(soft_cap_lamports <= hard_cap_lamports, FairLaunchError::InvalidCapConfig);
    require!(total_tokens_allocated > 0, FairLaunchError::ZeroTokenAllocation);

    let pool = &mut ctx.accounts.pool;
    pool.authority = ctx.accounts.authority.key();
    pool.token_mint = ctx.accounts.token_mint.key();
    pool.token_vault = ctx.accounts.token_vault.key();
    pool.start_slot = start_slot;
    pool.end_slot = end_slot;
    pool.soft_cap_lamports = soft_cap_lamports;
    pool.hard_cap_lamports = hard_cap_lamports;
    pool.total_sol_deposited = 0;
    pool.total_tokens_allocated = total_tokens_allocated;
    pool.is_finalized = false;
    pool.is_successful = false;
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.token_vault;

    // Escrow the allocated $CHIMP tokens into the pool's token vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.authority_token_account.to_account_info(),
            to: ctx.accounts.token_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, total_tokens_allocated)?;

    Ok(())
}
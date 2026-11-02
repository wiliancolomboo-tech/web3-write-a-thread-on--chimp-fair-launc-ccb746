use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Ch1mpFa1rLaunch11111111111111111111111111111");

#[program]
pub mod chimp_fair_launch {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        total_tokens: u64,
        hard_cap: u64,
        soft_cap: u64,
        max_per_wallet: u64,
        min_per_wallet: u64,
        duration_slots: u64,
    ) -> Result<()> {
        instructions::initialize::handle_initialize_pool(
            ctx,
            total_tokens,
            hard_cap,
            soft_cap,
            max_per_wallet,
            min_per_wallet,
            duration_slots,
        )
    }

    pub fn deposit_sol(ctx: Context<DepositSol>, lamports: u64) -> Result<()> {
        instructions::deposit::handle_deposit_sol(ctx, lamports)
    }

    pub fn finalize_pool(ctx: Context<FinalizePool>) -> Result<()> {
        instructions::finalize::handle_finalize_pool(ctx)
    }

    pub fn claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
        instructions::claim::handle_claim_tokens(ctx)
    }
}
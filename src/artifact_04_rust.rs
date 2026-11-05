use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("CH1MPy8v3E4YFkUu7oFh3h7W9Y5V1z5aBcDeFgHiJkLm");

#[program]
pub mod chimp_fair_launch {
    use super::*;

    /// Initializes a new $CHIMP Fair Launch pool with configured bounds and token escrow
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        total_tokens_allocated: u64,
        start_slot: u64,
        end_slot: u64,
        soft_cap_lamports: u64,
        hard_cap_lamports: u64,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            total_tokens_allocated,
            start_slot,
            end_slot,
            soft_cap_lamports,
            hard_cap_lamports,
        )
    }

    /// Deposits lamports into the fair launch pool during the active epoch
    pub fn contribute(ctx: Context<Contribute>, amount_lamports: u64) -> Result<()> {
        instructions::contribute::handler(ctx, amount_lamports)
    }

    /// Finalizes the pool after end_slot, calculating uniform clearing metrics
    pub fn finalize_pool(ctx: Context<FinalizePool>) -> Result<()> {
        instructions::finalize::handler(ctx)
    }

    /// Claims $CHIMP tokens and any pro-rata excess SOL refunds
    pub fn claim_tokens_and_refund(ctx: Context<ClaimTokensAndRefund>) -> Result<()> {
        instructions::claim::handler(ctx)
    }
}
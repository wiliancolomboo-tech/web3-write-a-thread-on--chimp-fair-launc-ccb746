use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct LaunchPool {
    /// Authority responsible for bootstrap
    pub authority: Pubkey,
    /// $CHIMP Mint address
    pub token_mint: Pubkey,
    /// PDA token account holding total $CHIMP to be distributed
    pub token_vault: Pubkey,
    /// Slot when contribution phase begins
    pub start_slot: u64,
    /// Slot when contribution phase ends
    pub end_slot: u64,
    /// Minimum lamports required for launch to be successful
    pub soft_cap_lamports: u64,
    /// Maximum lamports accepted for effective clearing (excess refunded pro-rata)
    pub hard_cap_lamports: u64,
    /// Total lamports contributed across all participants
    pub total_sol_deposited: u64,
    /// Total $CHIMP tokens deposited into pool vault
    pub total_tokens_allocated: u64,
    /// True if finalize_pool has executed
    pub is_finalized: bool,
    /// True if soft cap was met and pool completed successfully
    pub is_successful: bool,
    /// Bump seed for pool PDA
    pub bump: u8,
    /// Bump seed for vault PDA
    pub vault_bump: u8,
}

impl LaunchPool {
    pub const LEN: usize = 8 + // discriminator
        32 + // authority
        32 + // token_mint
        32 + // token_vault
        8 +  // start_slot
        8 +  // end_slot
        8 +  // soft_cap_lamports
        8 +  // hard_cap_lamports
        8 +  // total_sol_deposited
        8 +  // total_tokens_allocated
        1 +  // is_finalized
        1 +  // is_successful
        1 +  // bump
        1;   // vault_bump
}

#[account]
#[derive(Default)]
pub struct ContributionReceipt {
    /// Participant address
    pub user: Pubkey,
    /// Associated LaunchPool
    pub pool: Pubkey,
    /// Cumulative lamports deposited by user
    pub lamports_contributed: u64,
    /// True once tokens/refunds have been claimed
    pub has_claimed: bool,
    /// Bump seed for receipt PDA
    pub bump: u8,
}

impl ContributionReceipt {
    pub const LEN: usize = 8 + // discriminator
        32 + // user
        32 + // pool
        8 +  // lamports_contributed
        1 +  // has_claimed
        1;   // bump
}
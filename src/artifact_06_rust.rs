use anchor_lang::prelude::*;

#[event]
pub struct LaunchInitializedEvent {
    pub launch_id: u64,
    pub total_tokens_allocated: u64,
    pub start_slot: u64,
    pub end_slot: u64,
    pub soft_cap_lamports: u64,
    pub hard_cap_lamports: u64,
}

#[event]
pub struct DepositEvent {
    pub launch_id: u64,
    pub participant: Pubkey,
    pub lamports_deposited: u64,
    pub total_user_deposit: u64,
    pub total_vault_balance: u64,
    pub timestamp: i64,
}

#[event]
pub struct LaunchFinalizedEvent {
    pub launch_id: u64,
    pub total_lamports_raised: u64,
    pub total_tokens_available: u64,
    pub final_clearing_price_lamports_per_token: u64,
    pub pool_seed_lamports: u64,
    pub timestamp: i64,
}

#[event]
pub struct TokensClaimedEvent {
    pub launch_id: u64,
    pub participant: Pubkey,
    pub tokens_claimed: u64,
    pub timestamp: i64,
}
use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct LaunchConfig {
    pub admin: Pubkey,
    pub launch_id: u64,
    pub chimp_mint: Pubkey,
    pub token_escrow: Pubkey,
    pub sol_vault: Pubkey,
    pub total_tokens_allocated: u64,
    pub total_lamports_raised: u64,
    pub start_slot: u64,
    pub end_slot: u64,
    pub min_deposit_lamports: u64,
    pub max_deposit_lamports: u64,
    pub soft_cap_lamports: u64,
    pub hard_cap_lamports: u64,
    pub merkle_root: [u8; 32],
    pub is_finalized: bool,
    pub is_soft_cap_reached: bool,
    pub liquidity_seeded: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl LaunchConfig {
    pub const LEN: usize = 8 + // discriminator
        32 + // admin
        8  + // launch_id
        32 + // chimp_mint
        32 + // token_escrow
        32 + // sol_vault
        8  + // total_tokens_allocated
        8  + // total_lamports_raised
        8  + // start_slot
        8  + // end_slot
        8  + // min_deposit_lamports
        8  + // max_deposit_lamports
        8  + // soft_cap_lamports
        8  + // hard_cap_lamports
        32 + // merkle_root
        1  + // is_finalized
        1  + // is_soft_cap_reached
        1  + // liquidity_seeded
        1  + // bump
        1  + // vault_bump
        64;  // padding
}

#[account]
#[derive(Default)]
pub struct UserContribution {
    pub participant: Pubkey,
    pub launch_id: u64,
    pub lamports_contributed: u64,
    pub tokens_claimed: u64,
    pub claimed: bool,
    pub bump: u8,
}

impl UserContribution {
    pub const LEN: usize = 8 + // discriminator
        32 + // participant
        8  + // launch_id
        8  + // lamports_contributed
        8  + // tokens_claimed
        1  + // claimed
        1  + // bump
        32;  // padding
}
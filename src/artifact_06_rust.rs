use anchor_lang::prelude::*;

#[error_code]
pub enum FairLaunchError {
    #[msg("Invalid slot configuration: start_slot must be strictly less than end_slot.")]
    InvalidSlotRange,
    #[msg("Invalid cap configuration: soft_cap must be less than or equal to hard_cap.")]
    InvalidCapConfig,
    #[msg("Zero token allocation provided for distribution.")]
    ZeroTokenAllocation,
    #[msg("Fair launch pool has not started yet.")]
    LaunchNotStarted,
    #[msg("Fair launch pool deposit window has concluded.")]
    LaunchEnded,
    #[msg("Fair launch pool is not yet eligible for finalization.")]
    EpochNotEnded,
    #[msg("Fair launch pool is already finalized.")]
    AlreadyFinalized,
    #[msg("Fair launch pool has not been finalized yet.")]
    NotFinalized,
    #[msg("Contribution amount must be greater than zero.")]
    ZeroContribution,
    #[msg("User has already claimed their tokens and refund.")]
    AlreadyClaimed,
    #[msg("Arithmetic overflow occurred during token or refund computation.")]
    MathOverflow,
    #[msg("Soft cap was not met; pool aborted. Only SOL refunds are available.")]
    SoftCapNotMet,
}
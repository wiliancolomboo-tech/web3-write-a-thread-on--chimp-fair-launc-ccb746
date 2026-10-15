use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("CH1MPfA1rLaunchEng1ne111111111111111111111");

pub const CONFIG_SEED: &[u8] = b"chimp_launch_config";
pub const VAULT_SOL_SEED: &[u8] = b"chimp_sol_vault";
pub const VAULT_TOKEN_SEED: &[u8] = b"chimp_token_vault";
pub const USER_DEPOSIT_SEED: &[u8] = b"chimp_user_deposit";

#[program]
pub mod chimp_fair_launch {
    use super::*;

    /// Initializes the Fair Launch pool with target allocations, time windows, and caps.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        total_tokens_for_sale: u64,
        min_sol_cap: u64,
        max_sol_cap: u64,
        start_time: i64,
        end_time: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(start_time >= clock.unix_timestamp, LaunchError::InvalidStartTime);
        require!(end_time > start_time, LaunchError::InvalidEndTime);
        require!(max_sol_cap > min_sol_cap, LaunchError::InvalidCaps);
        require!(total_tokens_for_sale > 0, LaunchError::ZeroTokensForSale);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.token_mint = ctx.accounts.token_mint.key();
        config.total_tokens_for_sale = total_tokens_for_sale;
        config.min_sol_cap = min_sol_cap;
        config.max_sol_cap = max_sol_cap;
        config.start_time = start_time;
        config.end_time = end_time;
        config.total_sol_deposited = 0;
        config.total_tokens_claimed = 0;
        config.total_surplus_refunded = 0;
        config.status = LaunchStatus::Active;
        config.bump = ctx.bumps.config;
        config.vault_sol_bump = ctx.bumps.sol_vault;
        config.vault_token_bump = ctx.bumps.token_vault;

        // Deposit launch tokens into the contract vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.authority_token_account.to_account_info(),
            to: ctx.accounts.token_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), total_tokens_for_sale)?;

        emit!(PoolInitializedEvent {
            token_mint: config.token_mint,
            total_tokens: total_tokens_for_sale,
            start_time,
            end_time,
            min_sol_cap,
            max_sol_cap,
        });

        Ok(())
    }

    /// Users deposit native SOL into the vault PDA during the active epoch.
    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        let clock = Clock::get()?;
        let config = &mut ctx.accounts.config;

        require!(config.status == LaunchStatus::Active, LaunchError::PoolNotActive);
        require!(clock.unix_timestamp >= config.start_time, LaunchError::EpochNotStarted);
        require!(clock.unix_timestamp <= config.end_time, LaunchError::EpochEnded);
        require!(amount > 0, LaunchError::ZeroDeposit);

        // Native SOL transfer from user to Launch SOL Vault PDA
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.user.key(),
            &ctx.accounts.sol_vault.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.sol_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let user_deposit = &mut ctx.accounts.user_deposit;
        if user_deposit.user == Pubkey::default() {
            user_deposit.user = ctx.accounts.user.key();
            user_deposit.pool = config.key();
            user_deposit.deposited_sol = 0;
            user_deposit.has_claimed = false;
            user_deposit.bump = ctx.bumps.user_deposit;
        }

        user_deposit.deposited_sol = user_deposit
            .deposited_sol
            .checked_add(amount)
            .ok_or(LaunchError::MathOverflow)?;

        config.total_sol_deposited = config
            .total_sol_deposited
            .checked_add(amount)
            .ok_or(LaunchError::MathOverflow)?;

        emit!(SolDepositedEvent {
            user: ctx.accounts.user.key(),
            amount,
            cumulative_user_sol: user_deposit.deposited_sol,
            cumulative_total_sol: config.total_sol_deposited,
        });

        Ok(())
    }

    /// Closes the deposit window, locks final price discovery, transitions state to Sealed/Finalized.
    pub fn finalize_pool(ctx: Context<FinalizePool>) -> Result<()> {
        let clock = Clock::get()?;
        let config = &mut ctx.accounts.config;

        require!(config.status == LaunchStatus::Active, LaunchError::PoolNotActive);
        require!(
            clock.unix_timestamp > config.end_time || config.total_sol_deposited >= config.max_sol_cap,
            LaunchError::EpochNotReadyToFinalize
        );

        if config.total_sol_deposited < config.min_sol_cap {
            config.status = LaunchStatus::Failed;
            emit!(PoolFinalizedEvent {
                status: LaunchStatus::Failed,
                total_sol: config.total_sol_deposited,
                tokens_sold: 0,
                clearing_price_lamports_per_token: 0,
            });
            return Ok(());
        }

        config.status = LaunchStatus::Finalized;

        // Effective pricing evaluation
        let effective_sol = std::cmp::min(config.total_sol_deposited, config.max_sol_cap);
        // Price = (effective_sol * 1e9) / total_tokens_for_sale
        let clearing_price = (effective_sol as u128)
            .checked_mul(1_000_000_000u128)
            .ok_or(LaunchError::MathOverflow)?
            .checked_div(config.total_tokens_for_sale as u128)
            .ok_or(LaunchError::MathOverflow)? as u64;

        emit!(PoolFinalizedEvent {
            status: LaunchStatus::Finalized,
            total_sol: config.total_sol_deposited,
            tokens_sold: config.total_tokens_for_sale,
            clearing_price_lamports_per_token: clearing_price,
        });

        Ok(())
    }

    /// Participants claim their pro-rata tokens and receive surplus SOL refunds if pool exceeded hard cap.
    pub fn claim_and_refund(ctx: Context<ClaimAndRefund>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let user_deposit = &mut ctx.accounts.user_deposit;

        require!(!user_deposit.has_claimed, LaunchError::AlreadyClaimed);
        require!(user_deposit.deposited_sol > 0, LaunchError::ZeroDeposit);

        if config.status == LaunchStatus::Failed {
            // Full Refund of deposited SOL
            user_deposit.has_claimed = true;
            let refund_amount = user_deposit.deposited_sol;

            **ctx.accounts.sol_vault.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts
                .sol_vault
                .to_account_info()
                .lamports()
                .checked_sub(refund_amount)
                .ok_or(LaunchError::InsufficientVaultFunds)?;

            **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts
                .user
                .to_account_info()
                .lamports()
                .checked_add(refund_amount)
                .ok_or(LaunchError::MathOverflow)?;

            emit!(RefundProcessedEvent {
                user: ctx.accounts.user.key(),
                sol_refunded: refund_amount,
            });
            return Ok(());
        }

        require!(config.status == LaunchStatus::Finalized, LaunchError::PoolNotFinalized);

        let total_sol = config.total_sol_deposited;
        let max_sol = config.max_sol_cap;
        let user_sol = user_deposit.deposited_sol;

        let (token_allocation, sol_refund) = if total_sol <= max_sol {
            // Pro-rata based on actual deposited SOL
            let tokens = (user_sol as u128)
                .checked_mul(config.total_tokens_for_sale as u128)
                .ok_or(LaunchError::MathOverflow)?
                .checked_div(total_sol as u128)
                .ok_or(LaunchError::MathOverflow)? as u64;
            (tokens, 0u64)
        } else {
            // Oversubscribed: Pro-rata allocation based on Max Cap + Refund excess
            let user_effective_sol = (user_sol as u128)
                .checked_mul(max_sol as u128)
                .ok_or(LaunchError::MathOverflow)?
                .checked_div(total_sol as u128)
                .ok_or(LaunchError::MathOverflow)? as u64;

            let tokens = (user_effective_sol as u128)
                .checked_mul(config.total_tokens_for_sale as u128)
                .ok_or(LaunchError::MathOverflow)?
                .checked_div(max_sol as u128)
                .ok_or(LaunchError::MathOverflow)? as u64;

            let refund = user_sol
                .checked_sub(user_effective_sol)
                .ok_or(LaunchError::MathOverflow)?;

            (tokens, refund)
        };

        user_deposit.has_claimed = true;
        config.total_tokens_claimed = config
            .total_tokens_claimed
            .checked_add(token_allocation)
            .ok_or(LaunchError::MathOverflow)?;
        config.total_surplus_refunded = config
            .total_surplus_refunded
            .checked_add(sol_refund)
            .ok_or(LaunchError::MathOverflow)?;

        // Execute Surplus Refund Transfer (if any)
        if sol_refund > 0 {
            **ctx.accounts.sol_vault.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts
                .sol_vault
                .to_account_info()
                .lamports()
                .checked_sub(sol_refund)
                .ok_or(LaunchError::InsufficientVaultFunds)?;

            **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts
                .user
                .to_account_info()
                .lamports()
                .checked_add(sol_refund)
                .ok_or(LaunchError::MathOverflow)?;
        }

        // Execute $CHIMP Token Distribution via CPI using PDA Signer Seeds
        let authority_key = config.authority;
        let seeds = &[
            CONFIG_SEED,
            authority_key.as_ref(),
            &[config.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.token_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: config.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
            token_allocation,
        )?;

        emit!(ClaimProcessedEvent {
            user: ctx.accounts.user.key(),
            tokens_claimed: token_allocation,
            sol_refunded: sol_refund,
        });

        Ok(())
    }

    /// Admin withdraws accumulated non-surplus SOL for liquidity provision and project treasury.
    pub fn withdraw_settled_funds(ctx: Context<WithdrawSettledFunds>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(config.status == LaunchStatus::Finalized, LaunchError::PoolNotFinalized);

        let effective_sol = std::cmp::min(config.total_sol_deposited, config.max_sol_cap);
        let current_vault_lamports = ctx.accounts.sol_vault.to_account_info().lamports();

        // Ensure we do not drain unrefunded surplus lamports
        let unrefunded_surplus = if config.total_sol_deposited > config.max_sol_cap {
            let total_surplus = config.total_sol_deposited.checked_sub(config.max_sol_cap).unwrap();
            total_surplus.checked_sub(config.total_surplus_refunded).unwrap()
        } else {
            0
        };

        let rent_exempt_minimum = Rent::get()?.minimum_balance(0);
        let required_reserves = unrefunded_surplus.checked_add(rent_exempt_minimum).unwrap();

        require!(current_vault_lamports >= required_reserves + effective_sol, LaunchError::SurplusProtectionTriggered);

        **ctx.accounts.sol_vault.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .sol_vault
            .to_account_info()
            .lamports()
            .checked_sub(effective_sol)
            .ok_or(LaunchError::InsufficientVaultFunds)?;

        **ctx.accounts.authority.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .authority
            .to_account_info()
            .lamports()
            .checked_add(effective_sol)
            .ok_or(LaunchError::MathOverflow)?;

        emit!(FundsWithdrawnEvent {
            authority: ctx.accounts.authority.key(),
            sol_amount: effective_sol,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------------

#[derive(Accounts)]
pub fn initialize_pool<'info>(ctx: Context<InitializePool>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + LaunchConfig::LEN,
        seeds = [CONFIG_SEED, authority.key().as_ref()],
        bump
    )]
    pub config: Account<'info, LaunchConfig>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = authority
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_TOKEN_SEED, config.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = config
    )]
    pub token_vault: Account<'info, TokenAccount>,

    /// CHECK: Native SOL Escrow account controlled by PDA seeds
    #[account(
        mut,
        seeds = [VAULT_SOL_SEED, config.key().as_ref()],
        bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.authority.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, LaunchConfig>,

    /// CHECK: Native SOL Escrow account verified by seeds
    #[account(
        mut,
        seeds = [VAULT_SOL_SEED, config.key().as_ref()],
        bump = config.vault_sol_bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserDeposit::LEN,
        seeds = [USER_DEPOSIT_SEED, config.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_deposit: Account<'info, UserDeposit>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizePool<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.authority.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, LaunchConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimAndRefund<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.authority.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, LaunchConfig>,

    #[account(
        mut,
        seeds = [USER_DEPOSIT_SEED, config.key().as_ref(), user.key().as_ref()],
        bump = user_deposit.bump
    )]
    pub user_deposit: Account<'info, UserDeposit>,

    /// CHECK: Verified by seeds
    #[account(
        mut,
        seeds = [VAULT_SOL_SEED, config.key().as_ref()],
        bump = config.vault_sol_bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_TOKEN_SEED, config.key().as_ref()],
        bump = config.vault_token_bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = config.token_mint,
        token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSettledFunds<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.authority.as_ref()],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Account<'info, LaunchConfig>,

    /// CHECK: Sol vault verified by seeds
    #[account(
        mut,
        seeds = [VAULT_SOL_SEED, config.key().as_ref()],
        bump = config.vault_sol_bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------------
// State & Structs
// ---------------------------------------------------------------------------------

#[account]
pub struct LaunchConfig {
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub total_tokens_for_sale: u64,
    pub min_sol_cap: u64,
    pub max_sol_cap: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub total_sol_deposited: u64,
    pub total_tokens_claimed: u64,
    pub total_surplus_refunded: u64,
    pub status: LaunchStatus,
    pub bump: u8,
    pub vault_sol_bump: u8,
    pub vault_token_bump: u8,
}

impl LaunchConfig {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1;
}

#[account]
pub struct UserDeposit {
    pub user: Pubkey,
    pub pool: Pubkey,
    pub deposited_sol: u64,
    pub has_claimed: bool,
    pub bump: u8,
}

impl UserDeposit {
    pub const LEN: usize = 32 + 32 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum LaunchStatus {
    Active,
    Sealed,
    Finalized,
    Failed,
}

// ---------------------------------------------------------------------------------
// Events & Errors
// ---------------------------------------------------------------------------------

#[event]
pub struct PoolInitializedEvent {
    pub token_mint: Pubkey,
    pub total_tokens: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub min_sol_cap: u64,
    pub max_sol_cap: u64,
}

#[event]
pub struct SolDepositedEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub cumulative_user_sol: u64,
    pub cumulative_total_sol: u64,
}

#[event]
pub struct PoolFinalizedEvent {
    pub status: LaunchStatus,
    pub total_sol: u64,
    pub tokens_sold: u64,
    pub clearing_price_lamports_per_token: u64,
}

#[event]
pub struct ClaimProcessedEvent {
    pub user: Pubkey,
    pub tokens_claimed: u64,
    pub sol_refunded: u64,
}

#[event]
pub struct RefundProcessedEvent {
    pub user: Pubkey,
    pub sol_refunded: u64,
}

#[event]
pub struct FundsWithdrawnEvent {
    pub authority: Pubkey,
    pub sol_amount: u64,
}

#[error_code]
pub enum LaunchError {
    #[msg("Start time must be in the future.")]
    InvalidStartTime,
    #[msg("End time must be after start time.")]
    InvalidEndTime,
    #[msg("Max SOL cap must exceed Min SOL cap.")]
    InvalidCaps,
    #[msg("Total tokens for sale must be non-zero.")]
    ZeroTokensForSale,
    #[msg("Fair launch pool is not active.")]
    PoolNotActive,
    #[msg("Deposit epoch has not started yet.")]
    EpochNotStarted,
    #[msg("Deposit epoch has closed.")]
    EpochEnded,
    #[msg("Deposit amount must be greater than zero.")]
    ZeroDeposit,
    #[msg("Mathematical overflow or underflow detected.")]
    MathOverflow,
    #[msg("Epoch conditions have not met the criteria to finalize.")]
    EpochNotReadyToFinalize,
    #[msg("Pool has already been claimed for this user.")]
    AlreadyClaimed,
    #[msg("Pool is not finalized.")]
    PoolNotFinalized,
    #[msg("Solana vault has insufficient lamports for transfer.")]
    InsufficientVaultFunds,
    #[msg("Withdrawal would violate surplus reserve protection.")]
    SurplusProtectionTriggered,
}
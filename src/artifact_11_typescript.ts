import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ChimpFairLaunch } from "../target/types/chimp_fair_launch";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";

describe("chimp_fair_launch protocol validation suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;
  const authority = provider.wallet as anchor.Wallet;

  let tokenMint: anchor.web3.PublicKey;
  let authorityTokenAccount: anchor.web3.PublicKey;
  let poolPda: anchor.web3.PublicKey;
  let poolBump: number;
  let tokenVaultPda: anchor.web3.PublicKey;
  let vaultEscrowPda: anchor.web3.PublicKey;

  const testContributor = anchor.web3.Keypair.generate();
  let userContributionPda: anchor.web3.PublicKey;
  let userTokenAccount: anchor.web3.PublicKey;

  const TOTAL_TOKENS_FOR_SALE = new anchor.BN(10_000_000_000_000); // 10M tokens with 6 decimals
  const MIN_CONTRIBUTION = new anchor.BN(100_000_000); // 0.1 SOL
  const MAX_CONTRIBUTION = new anchor.BN(5_000_000_000); // 5 SOL
  const SOFT_CAP = new anchor.BN(10_000_000_000); // 10 SOL
  const HARD_CAP = new anchor.BN(50_000_000_000); // 50 SOL

  before(async () => {
    // 1. Airdrop SOL to test contributor
    const sig = await provider.connection.requestAirdrop(
      testContributor.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    // 2. Create Mint & allocate authority tokens
    tokenMint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      6
    );

    authorityTokenAccount = await createAccount(
      provider.connection,
      authority.payer,
      tokenMint,
      authority.publicKey
    );

    await mintTo(
      provider.connection,
      authority.payer,
      tokenMint,
      authorityTokenAccount,
      authority.payer,
      100_000_000_000_000
    );

    // 3. Derive Program PDAs
    [poolPda, poolBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_pool"), tokenMint.toBuffer()],
      program.programId
    );

    [tokenVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), poolPda.toBuffer()],
      program.programId
    );

    [vaultEscrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_escrow"), poolPda.toBuffer()],
      program.programId
    );

    [userContributionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_contribution"),
        poolPda.toBuffer(),
        testContributor.publicKey.toBuffer(),
      ],
      program.programId
    );

    userTokenAccount = await createAccount(
      provider.connection,
      testContributor,
      tokenMint,
      testContributor.publicKey
    );
  });

  it("Executes Pool Initialization with Escrow Lock", async () => {
    const currentSlot = await provider.connection.getSlot("confirmed");
    const startSlot = new anchor.BN(currentSlot);
    const endSlot = new anchor.BN(currentSlot + 50);

    await program.methods
      .initializePool(
        TOTAL_TOKENS_FOR_SALE,
        MIN_CONTRIBUTION,
        MAX_CONTRIBUTION,
        SOFT_CAP,
        HARD_CAP,
        startSlot,
        endSlot
      )
      .accounts({
        pool: poolPda,
        tokenMint: tokenMint,
        tokenVault: tokenVaultPda,
        authorityTokenAccount: authorityTokenAccount,
        vaultEscrow: vaultEscrowPda,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const poolState = await program.account.launchPool.fetch(poolPda);
    assert.isTrue(poolState.tokenMint.equals(tokenMint));
    assert.equal(poolState.totalTokensForSale.toString(), TOTAL_TOKENS_FOR_SALE.toString());
    assert.equal(poolState.totalSolCollected.toNumber(), 0);

    const vaultAccount = await getAccount(provider.connection, tokenVaultPda);
    assert.equal(vaultAccount.amount.toString(), TOTAL_TOKENS_FOR_SALE.toString());
  });

  it("Enforces Minimum Contribution Bounds", async () => {
    const microDeposit = new anchor.BN(50_000_000); // 0.05 SOL (< 0.1 SOL limit)

    try {
      await program.methods
        .depositSol(microDeposit)
        .accounts({
          pool: poolPda,
          userContribution: userContributionPda,
          vaultEscrow: vaultEscrowPda,
          user: testContributor.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([testContributor])
        .rpc();
      assert.fail("Should have thrown BelowMinContribution error");
    } catch (_err: any) {
      expect(_err.toString()).to.include("BelowMinContribution");
    }
  });

  it("Accepts Valid SOL Deposit and Updates Escrow Balances", async () => {
    const depositAmount = new anchor.BN(1_000_000_000); // 1.0 SOL

    await program.methods
      .depositSol(depositAmount)
      .accounts({
        pool: poolPda,
        userContribution: userContributionPda,
        vaultEscrow: vaultEscrowPda,
        user: testContributor.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([testContributor])
      .rpc();

    const userRecord = await program.account.userContribution.fetch(userContributionPda);
    assert.equal(userRecord.lamportsContributed.toString(), depositAmount.toString());
    assert.isFalse(userRecord.claimed);

    const poolState = await program.account.launchPool.fetch(poolPda);
    assert.equal(poolState.totalSolCollected.toString(), depositAmount.toString());
  });

  it("Rejects Deposits that Exceed Wallet Limit", async () => {
    const excessDeposit = new anchor.BN(5_000_000_000); // 5 SOL + 1 SOL previous = 6 SOL (> 5 SOL cap)

    try {
      await program.methods
        .depositSol(excessDeposit)
        .accounts({
          pool: poolPda,
          userContribution: userContributionPda,
          vaultEscrow: vaultEscrowPda,
          user: testContributor.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([testContributor])
        .rpc();
      assert.fail("Should have rejected deposit surpassing individual max limit");
    } catch (_err: any) {
      expect(_err.toString()).to.include("ExceedsWalletLimit");
    }
  });

  it("Finalizes Pool and Allows Accurate Pro-Rata Token Claim", async () => {
    // Fast-forward slots until slot > endSlot
    let currentSlot = await provider.connection.getSlot("confirmed");
    const poolState = await program.account.launchPool.fetch(poolPda);

    while (currentSlot <= poolState.endSlot.toNumber()) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      currentSlot = await provider.connection.getSlot("confirmed");
    }

    // Finalize
    await program.methods
      .finalizePool()
      .accounts({
        pool: poolPda,
        caller: authority.publicKey,
      })
      .rpc();

    const updatedPool = await program.account.launchPool.fetch(poolPda);
    assert.isTrue(updatedPool.isFinalized);

    // Claim Tokens
    await program.methods
      .claimTokens()
      .accounts({
        pool: poolPda,
        userContribution: userContributionPda,
        tokenVault: tokenVaultPda,
        userTokenAccount: userTokenAccount,
        user: testContributor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([testContributor])
      .rpc();

    const userTokenBalance = await getAccount(provider.connection, userTokenAccount);
    // Since testContributor contributed 100% of the solitary pool deposits (1 SOL):
    assert.equal(userTokenBalance.amount.toString(), TOTAL_TOKENS_FOR_SALE.toString());

    const userRecord = await program.account.userContribution.fetch(userContributionPda);
    assert.isTrue(userRecord.claimed);
  });
});
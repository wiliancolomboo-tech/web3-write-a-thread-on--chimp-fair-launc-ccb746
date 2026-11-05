import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ChimpFairLaunch } from "../target/types/chimp_fair_launch";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("chimp_fair_launch Enterprise Test Harness", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;

  const poolName = "CHIMP_STAGE_1";
  let tokenMint: PublicKey;
  let authorityTokenAccount: PublicKey;
  let poolPda: PublicKey;
  let tokenVaultPda: PublicKey;
  let solVaultPda: PublicKey;

  const authority = provider.wallet as anchor.Wallet;
  const contributor1 = Keypair.generate();
  const contributor2 = Keypair.generate();
  const attacker = Keypair.generate();

  const tokenAllocation = new anchor.BN(10_000_000 * 10 ** 6); // 10M tokens
  const minRaise = new anchor.BN(5 * LAMPORTS_PER_SOL);        // 5 SOL softcap
  const maxRaise = new anchor.BN(20 * LAMPORTS_PER_SOL);       // 20 SOL hardcap
  const maxContribution = new anchor.BN(10 * LAMPORTS_PER_SOL);// 10 SOL cap/wallet

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [contributor1, contributor2, attacker]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 50 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Derive PDAs
    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("fair_launch"), Buffer.from(poolName)],
      program.programId
    );
    [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), Buffer.from(poolName)],
      program.programId
    );
    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), Buffer.from(poolName)],
      program.programId
    );

    // Initialize Mint and Authority Token Escrow
    tokenMint = await createMint(
      provider.connection,
      (authority as any).payer,
      authority.publicKey,
      null,
      6
    );

    authorityTokenAccount = await createAccount(
      provider.connection,
      (authority as any).payer,
      tokenMint,
      authority.publicKey
    );

    await mintTo(
      provider.connection,
      (authority as any).payer,
      tokenMint,
      authorityTokenAccount,
      authority.publicKey,
      100_000_000 * 10 ** 6
    );
  });

  it("1. Successfully executes initialize_pool and escrows $CHIMP token allocation", async () => {
    const currentSlot = await provider.connection.getSlot();
    const startSlot = new anchor.BN(currentSlot + 1);
    const endSlot = new anchor.BN(currentSlot + 150);

    await program.methods
      .initializePool(
        poolName,
        tokenAllocation,
        minRaise,
        maxRaise,
        startSlot,
        endSlot,
        maxContribution
      )
      .accounts({
        pool: poolPda,
        tokenMint,
        tokenVault: tokenVaultPda,
        solVault: solVaultPda,
        authorityTokenAccount,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const poolState = await program.account.launchPool.fetch(poolPda);
    expect(poolState.poolName).to.equal(poolName);
    expect(poolState.totalSolRaised.toNumber()).to.equal(0);
    expect(poolState.isFinalized).to.be.false;

    const vaultAccount = await getAccount(provider.connection, tokenVaultPda);
    expect(vaultAccount.amount.toString()).to.equal(tokenAllocation.toString());
  });

  it("2. Accepts valid contribution and tracks PDA balance correctly", async () => {
    const [userContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), poolPda.toBuffer(), contributor1.publicKey.toBuffer()],
      program.programId
    );

    const depositAmount = new anchor.BN(6 * LAMPORTS_PER_SOL);

    await program.methods
      .contribute(depositAmount)
      .accounts({
        pool: poolPda,
        solVault: solVaultPda,
        userContribution: userContributionPda,
        user: contributor1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([contributor1])
      .rpc();

    const poolState = await program.account.launchPool.fetch(poolPda);
    expect(poolState.totalSolRaised.toString()).to.equal(depositAmount.toString());

    const userState = await program.account.userContribution.fetch(userContributionPda);
    expect(userState.solAmount.toString()).to.equal(depositAmount.toString());
    expect(userState.tokensClaimed).to.be.false;
  });

  it("3. Enforces individual user wallet cap restrictions", async () => {
    const [userContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), poolPda.toBuffer(), contributor1.publicKey.toBuffer()],
      program.programId
    );

    // Contributor 1 already deposited 6 SOL. Attempting 5 SOL more exceeds 10 SOL cap.
    const excessDeposit = new anchor.BN(5 * LAMPORTS_PER_SOL);

    try {
      await program.methods
        .contribute(excessDeposit)
        .accounts({
          pool: poolPda,
          solVault: solVaultPda,
          userContribution: userContributionPda,
          user: contributor1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([contributor1])
        .rpc();
      expect.fail("Should have thrown ExceedsUserCap error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ExceedsUserCap");
    }
  });

  it("4. Prevents finalization prior to end slot if hardcap is not reached", async () => {
    try {
      await program.methods
        .finalizePool()
        .accounts({
          pool: poolPda,
          authority: authority.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown LaunchStillActive");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("LaunchStillActive");
    }
  });

  it("5. Completes raise to hardcap, finalizes atomically, and distributes pro-rata", async () => {
    const [user2ContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), poolPda.toBuffer(), contributor2.publicKey.toBuffer()],
      program.programId
    );

    // Fill the remaining 14 SOL to trigger exact 20 SOL max_raise
    const finalDeposit = new anchor.BN(14 * LAMPORTS_PER_SOL);

    await program.methods
      .contribute(finalDeposit)
      .accounts({
        pool: poolPda,
        solVault: solVaultPda,
        userContribution: user2ContributionPda,
        user: contributor2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([contributor2])
      .rpc();

    // Pool hit hardcap; finalize should succeed immediately
    await program.methods
      .finalizePool()
      .accounts({
        pool: poolPda,
        authority: authority.publicKey,
      })
      .rpc();

    const poolState = await program.account.launchPool.fetch(poolPda);
    expect(poolState.isFinalized).to.be.true;
    expect(poolState.isCancelled).to.be.false;

    // Contributor 1 claims their pro-rata share: 6 / 20 = 30% of 10M tokens = 3,000,000 tokens
    const contributor1TokenAccount = await createAccount(
      provider.connection,
      (authority as any).payer,
      tokenMint,
      contributor1.publicKey
    );

    const [user1ContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), poolPda.toBuffer(), contributor1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimTokens()
      .accounts({
        pool: poolPda,
        tokenVault: tokenVaultPda,
        userContribution: user1ContributionPda,
        userTokenAccount: contributor1TokenAccount,
        user: contributor1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([contributor1])
      .rpc();

    const claimedAccount = await getAccount(provider.connection, contributor1TokenAccount);
    const expectedShare = (10_000_000 * 10 ** 6 * 0.30).toString();
    expect(claimedAccount.amount.toString()).to.equal(expectedShare);
  });
});
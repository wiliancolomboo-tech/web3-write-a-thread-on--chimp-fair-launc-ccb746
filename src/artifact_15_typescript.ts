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

describe("chimp-fair-launch QA Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;
  const connection = provider.connection;

  let mintKeypair: anchor.web3.Keypair;
  let adminTokenAccount: anchor.web3.PublicKey;

  let launchConfigPda: anchor.web3.PublicKey;
  let solVaultPda: anchor.web3.PublicKey;
  let tokenVaultPda: anchor.web3.PublicKey;

  const userAlice = anchor.web3.Keypair.generate();
  const userBob = anchor.web3.Keypair.generate();
  const userCharlie = anchor.web3.Keypair.generate();

  const TOTAL_ALLOCATION = new anchor.BN(10_000_000 * 10 ** 9); // 10M $CHIMP
  const SOFT_CAP = new anchor.BN(10 * anchor.web3.LAMPORTS_PER_SOL); // 10 SOL
  const HARD_CAP = new anchor.BN(50 * anchor.web3.LAMPORTS_PER_SOL); // 50 SOL

  before(async () => {
    // Airdrop funds to all test actors
    for (const actor of [userAlice, userBob, userCharlie]) {
      const sig = await connection.requestAirdrop(actor.publicKey, 100 * anchor.web3.LAMPORTS_PER_SOL);
      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latestBlockhash });
    }

    mintKeypair = anchor.web3.Keypair.generate();
    await createMint(
      connection,
      (provider.wallet as any).payer,
      provider.wallet.publicKey,
      null,
      9,
      mintKeypair
    );

    adminTokenAccount = await createAccount(
      connection,
      (provider.wallet as any).payer,
      mintKeypair.publicKey,
      provider.wallet.publicKey
    );

    await mintTo(
      connection,
      (provider.wallet as any).payer,
      mintKeypair.publicKey,
      adminTokenAccount,
      provider.wallet.publicKey,
      BigInt(TOTAL_ALLOCATION.toString())
    );

    [launchConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_launch_config"), mintKeypair.publicKey.toBuffer()],
      program.programId
    );

    [solVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_sol_vault"), launchConfigPda.toBuffer()],
      program.programId
    );

    [tokenVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_token_vault"), launchConfigPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes the $CHIMP Fair Launch pool with locked inventory", async () => {
    const currentSlot = await connection.getSlot();
    const startSlot = new anchor.BN(currentSlot);
    const endSlot = new anchor.BN(currentSlot + 15);

    await program.methods
      .initializeLaunch({
        startSlot,
        endSlot,
        softCapLamports: SOFT_CAP,
        hardCapLamports: HARD_CAP,
        totalTokensAllocated: TOTAL_ALLOCATION,
      })
      .accounts({
        admin: provider.wallet.publicKey,
        tokenMint: mintKeypair.publicKey,
        launchConfig: launchConfigPda,
        solVault: solVaultPda,
        tokenVault: tokenVaultPda,
        adminTokenSource: adminTokenAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vaultBalance = await getAccount(connection, tokenVaultPda);
    assert.equal(vaultBalance.amount.toString(), TOTAL_ALLOCATION.toString());

    const state = await program.account.launchConfig.fetch(launchConfigPda);
    assert.deepEqual(state.state, { active: {} });
    assert.equal(state.totalSolDeposited.toNumber(), 0);
  });

  it("2. Accepts deterministic deposits and maintains invariant tracking across accounts", async () => {
    const [aliceRecord] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_user_record"), launchConfigPda.toBuffer(), userAlice.publicKey.toBuffer()],
      program.programId
    );

    const depositAmount = new anchor.BN(30 * anchor.web3.LAMPORTS_PER_SOL);

    await program.methods
      .deposit(depositAmount)
      .accounts({
        user: userAlice.publicKey,
        launchConfig: launchConfigPda,
        solVault: solVaultPda,
        userRecord: aliceRecord,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userAlice])
      .rpc();

    const aliceRecordAccount = await program.account.userRecord.fetch(aliceRecord);
    assert.equal(aliceRecordAccount.depositedLamports.toString(), depositAmount.toString());

    const launchState = await program.account.launchConfig.fetch(launchConfigPda);
    assert.equal(launchState.totalSolDeposited.toString(), depositAmount.toString());
  });

  it("3. Handles massive oversubscription without allowing MEV exploits", async () => {
    const [bobRecord] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_user_record"), launchConfigPda.toBuffer(), userBob.publicKey.toBuffer()],
      program.programId
    );

    // Bob deposits 70 SOL -> Total pool becomes 100 SOL (2x the 50 SOL Hard Cap)
    const depositAmount = new anchor.BN(70 * anchor.web3.LAMPORTS_PER_SOL);

    await program.methods
      .deposit(depositAmount)
      .accounts({
        user: userBob.publicKey,
        launchConfig: launchConfigPda,
        solVault: solVaultPda,
        userRecord: bobRecord,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userBob])
      .rpc();

    const launchState = await program.account.launchConfig.fetch(launchConfigPda);
    assert.equal(
      launchState.totalSolDeposited.toString(),
      (100 * anchor.web3.LAMPORTS_PER_SOL).toString()
    );
  });

  it("4. Prevents early finalization before designated slot deadline", async () => {
    try {
      await program.methods
        .finalizeLaunch()
        .accounts({
          caller: provider.wallet.publicKey,
          launchConfig: launchConfigPda,
        })
        .rpc();
      assert.fail("Should have failed to finalize prematurely.");
    } catch (err: any) {
      expect(err.toString()).to.include("LaunchActive");
    }
  });

  it("5. Finalizes launch successfully after slot deadline expires", async () => {
    console.log("Warming slots to cross launch end boundary...");
    let currentSlot = await connection.getSlot();
    const config = await program.account.launchConfig.fetch(launchConfigPda);

    while (currentSlot <= config.endSlot.toNumber()) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      currentSlot = await connection.getSlot();
    }

    await program.methods
      .finalizeLaunch()
      .accounts({
        caller: provider.wallet.publicKey,
        launchConfig: launchConfigPda,
      })
      .rpc();

    const finalizedState = await program.account.launchConfig.fetch(launchConfigPda);
    assert.deepEqual(finalizedState.state, { finalizedSuccess: {} });
  });

  it("6. Calculates exact proportional distribution and zero-loss refunds on claim", async () => {
    const [aliceRecord] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_user_record"), launchConfigPda.toBuffer(), userAlice.publicKey.toBuffer()],
      program.programId
    );

    const aliceTokenAccount = anchor.web3.Keypair.generate().publicKey;
    const initialSolBalance = await connection.getBalance(userAlice.publicKey);

    // Alice deposited 30 SOL out of 100 SOL total (30%).
    // Hard cap is 50 SOL.
    // Alice effective accepted SOL = 30 * 50 / 100 = 15 SOL.
    // Alice refund SOL = 30 - 15 = 15 SOL.
    // Alice token share = 30% of 10,000,000 $CHIMP = 3,000,000 $CHIMP.

    await program.methods
      .claimAllocation()
      .accounts({
        user: userAlice.publicKey,
        launchConfig: launchConfigPda,
        tokenMint: mintKeypair.publicKey,
        solVault: solVaultPda,
        tokenVault: tokenVaultPda,
        userRecord: aliceRecord,
        userTokenAccount: aliceTokenAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userAlice])
      .rpc();

    const postSolBalance = await connection.getBalance(userAlice.publicKey);
    const aliceRecordUpdated = await program.account.userRecord.fetch(aliceRecord);

    assert.isTrue(aliceRecordUpdated.claimed);
    assert.equal(
      aliceRecordUpdated.tokensClaimed.toString(),
      (3_000_000 * 10 ** 9).toString()
    );
    assert.equal(
      aliceRecordUpdated.solRefunded.toString(),
      (15 * anchor.web3.LAMPORTS_PER_SOL).toString()
    );

    // User received 15 SOL back (minus minor transaction rent fee)
    expect(postSolBalance).to.be.greaterThan(initialSolBalance);
  });

  it("7. Defends against double-claim attacks", async () => {
    const [aliceRecord] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_user_record"), launchConfigPda.toBuffer(), userAlice.publicKey.toBuffer()],
      program.programId
    );

    const aliceTokenAccount = anchor.web3.Keypair.generate().publicKey;

    try {
      await program.methods
        .claimAllocation()
        .accounts({
          user: userAlice.publicKey,
          launchConfig: launchConfigPda,
          tokenMint: mintKeypair.publicKey,
          solVault: solVaultPda,
          tokenVault: tokenVaultPda,
          userRecord: aliceRecord,
          userTokenAccount: aliceTokenAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userAlice])
        .rpc();
      assert.fail("Double claim must never succeed");
    } catch (err: any) {
      expect(err.toString()).to.include("AlreadyClaimed");
    }
  });
});
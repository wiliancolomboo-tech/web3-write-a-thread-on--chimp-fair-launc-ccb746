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
import { assert, expect } from "chai";

describe("chimp_fair_launch Enterprise Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;

  const admin = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  let chimpMint: PublicKey;
  let adminTokenAta: PublicKey;
  let aliceTokenAta: PublicKey;
  let bobTokenAta: PublicKey;

  let launchPoolPda: PublicKey;
  let tokenVaultPda: PublicKey;
  let solVaultPda: PublicKey;
  let launchPoolBump: number;

  const TOKENS_OFFERED = new anchor.BN(10_000_000 * 1_000_000); // 10M tokens (6 decimals)
  const SOFT_CAP = new anchor.BN(5 * LAMPORTS_PER_SOL);
  const HARD_CAP = new anchor.BN(100 * LAMPORTS_PER_SOL);

  before(async () => {
    // Fund test wallets with native SOL
    for (const kp of [admin, alice, bob]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 50 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Deploy $CHIMP Mint
    chimpMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Derive Program PDAs
    [launchPoolPda, launchPoolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_pool"), chimpMint.toBuffer()],
      program.programId
    );

    [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), chimpMint.toBuffer()],
      program.programId
    );

    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), chimpMint.toBuffer()],
      program.programId
    );

    // Setup Admin ATA and mint initial allocation
    adminTokenAta = await createAccount(provider.connection, admin, chimpMint, admin.publicKey);
    aliceTokenAta = await createAccount(provider.connection, alice, chimpMint, alice.publicKey);
    bobTokenAta = await createAccount(provider.connection, bob, chimpMint, bob.publicKey);

    await mintTo(
      provider.connection,
      admin,
      chimpMint,
      adminTokenAta,
      admin,
      BigInt(TOKENS_OFFERED.toString())
    );
  });

  it("1. Initializes the launch pool successfully with token escrow", async () => {
    const currentSlot = await provider.connection.getSlot();
    const startSlot = new anchor.BN(currentSlot);
    const endSlot = new anchor.BN(currentSlot + 30); // 30-slot commitment window

    await program.methods
      .initializeLaunch(
        startSlot,
        endSlot,
        TOKENS_OFFERED,
        SOFT_CAP,
        HARD_CAP
      )
      .accounts({
        authority: admin.publicKey,
        tokenMint: chimpMint,
        launchPool: launchPoolPda,
        tokenVault: tokenVaultPda,
        authorityTokenAccount: adminTokenAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const poolState = await program.account.launchPool.fetch(launchPoolPda);
    assert.equal(poolState.authority.toBase58(), admin.publicKey.toBase58());
    assert.equal(poolState.totalTokensOffered.toString(), TOKENS_OFFERED.toString());
    assert.equal(poolState.status, 1); // LaunchStatus::Active

    const vaultAccount = await getAccount(provider.connection, tokenVaultPda);
    assert.equal(vaultAccount.amount.toString(), TOKENS_OFFERED.toString());
  });

  it("2. Accepts proportional deposits from multiple users", async () => {
    const aliceDeposit = new anchor.BN(10 * LAMPORTS_PER_SOL);
    const bobDeposit = new anchor.BN(30 * LAMPORTS_PER_SOL);

    const [aliceContribPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), launchPoolPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    const [bobContribPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), launchPoolPda.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );

    // Alice deposits 10 SOL
    await program.methods
      .depositSol(aliceDeposit)
      .accounts({
        contributor: alice.publicKey,
        launchPool: launchPoolPda,
        solVault: solVaultPda,
        contribution: aliceContribPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    // Bob deposits 30 SOL
    await program.methods
      .depositSol(bobDeposit)
      .accounts({
        contributor: bob.publicKey,
        launchPool: launchPoolPda,
        solVault: solVaultPda,
        contribution: bobContribPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([bob])
      .rpc();

    const pool = await program.account.launchPool.fetch(launchPoolPda);
    assert.equal(
      pool.totalSolDeposited.toString(),
      new anchor.BN(40 * LAMPORTS_PER_SOL).toString()
    );
    assert.equal(pool.participantCount.toNumber(), 2);
  });

  it("3. Rejects premature claims before launch finalization", async () => {
    const [aliceContribPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), launchPoolPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimTokens()
        .accounts({
          contributor: alice.publicKey,
          launchPool: launchPoolPda,
          tokenMint: chimpMint,
          tokenVault: tokenVaultPda,
          userContribution: aliceContribPda,
          contributorTokenAccount: aliceTokenAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([alice])
        .rpc();
      assert.fail("Should have thrown NotFinalized error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("NotFinalized");
    }
  });

  it("4. Finalizes after commitment epoch expires", async () => {
    // Advance slots past endSlot
    let currentSlot = await provider.connection.getSlot();
    const pool = await program.account.launchPool.fetch(launchPoolPda);
    
    while (currentSlot <= pool.endSlot.toNumber()) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      currentSlot = await provider.connection.getSlot();
    }

    await program.methods
      .finalizeLaunch()
      .accounts({
        caller: admin.publicKey,
        launchPool: launchPoolPda,
      })
      .signers([admin])
      .rpc();

    const updatedPool = await program.account.launchPool.fetch(launchPoolPda);
    assert.equal(updatedPool.status, 2); // Finalized
  });

  it("5. Settles pro-rata token allocation exactly (Alice 25%, Bob 75%)", async () => {
    const [aliceContribPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), launchPoolPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );
    const [bobContribPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), launchPoolPda.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );

    // Alice claims (10 SOL / 40 SOL = 25% of 10M tokens = 2,500,000)
    await program.methods
      .claimTokens()
      .accounts({
        contributor: alice.publicKey,
        launchPool: launchPoolPda,
        tokenMint: chimpMint,
        tokenVault: tokenVaultPda,
        userContribution: aliceContribPda,
        contributorTokenAccount: aliceTokenAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    // Bob claims (30 SOL / 40 SOL = 75% of 10M tokens = 7,500,000)
    await program.methods
      .claimTokens()
      .accounts({
        contributor: bob.publicKey,
        launchPool: launchPoolPda,
        tokenMint: chimpMint,
        tokenVault: tokenVaultPda,
        userContribution: bobContribPda,
        contributorTokenAccount: bobTokenAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([bob])
      .rpc();

    const aliceBalance = await getAccount(provider.connection, aliceTokenAta);
    const bobBalance = await getAccount(provider.connection, bobTokenAta);

    assert.equal(aliceBalance.amount.toString(), "2500000000000"); // 2.5M tokens with 6 decimals
    assert.equal(bobBalance.amount.toString(), "7500000000000"); // 7.5M tokens with 6 decimals
  });

  it("6. Rejects double claiming", async () => {
    const [aliceContribPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), launchPoolPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimTokens()
        .accounts({
          contributor: alice.publicKey,
          launchPool: launchPoolPda,
          tokenMint: chimpMint,
          tokenVault: tokenVaultPda,
          userContribution: aliceContribPda,
          contributorTokenAccount: aliceTokenAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([alice])
        .rpc();
      assert.fail("Double claim must fail");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AlreadyClaimed");
    }
  });
});
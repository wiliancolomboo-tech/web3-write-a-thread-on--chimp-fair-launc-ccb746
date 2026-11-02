import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ChimpFairLaunch } from "../target/types/chimp_fair_launch";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("chimp_fair_launch protocol verification matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;

  let authority: Keypair;
  let buyerAlice: Keypair;
  let buyerBob: Keypair;
  let tokenMint: PublicKey;
  let authorityTokenAta: PublicKey;
  let poolPda: PublicKey;
  let solVaultPda: PublicKey;
  let tokenVaultPda: PublicKey;

  const launchId = new BN(88201);
  const tokensAllocated = new BN(1_000_000 * 10 ** 6); // 1,000,000 $CHIMP (6 decimals)
  const minCommitLamports = new BN(0.2 * LAMPORTS_PER_SOL);
  const maxCommitLamports = new BN(5.0 * LAMPORTS_PER_SOL);

  let startSlot: number;
  let endSlot: number;

  before(async () => {
    authority = Keypair.generate();
    buyerAlice = Keypair.generate();
    buyerBob = Keypair.generate();

    // Airdrop SOL to test actors
    for (const actor of [authority, buyerAlice, buyerBob]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        50 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Create $CHIMP Token Mint
    tokenMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    authorityTokenAta = await createAccount(
      provider.connection,
      authority,
      tokenMint,
      authority.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      tokenMint,
      authorityTokenAta,
      authority,
      10_000_000 * 10 ** 6
    );

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_pool"), launchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), poolPda.toBuffer()],
      program.programId
    );

    [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), poolPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes Fair Launch Pool with Escrowed $CHIMP", async () => {
    const currentSlot = await provider.connection.getSlot("processed");
    startSlot = currentSlot + 10;
    endSlot = currentSlot + 40;

    await program.methods
      .initializePool(
        launchId,
        new BN(startSlot),
        new BN(endSlot),
        tokensAllocated,
        minCommitLamports,
        maxCommitLamports
      )
      .accounts({
        launchPool: poolPda,
        solVault: solVaultPda,
        tokenMint: tokenMint,
        tokenVault: tokenVaultPda,
        authorityTokenAccount: authorityTokenAta,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const poolState = await program.account.launchPool.fetch(poolPda);
    expect(poolState.tokensForSale.toString()).to.equal(tokensAllocated.toString());
    expect(poolState.isFinalized).to.be.false;

    const vaultBalance = await getAccount(provider.connection, tokenVaultPda);
    expect(vaultBalance.amount.toString()).to.equal(tokensAllocated.toString());
  });

  it("2. Rejects early commitment prior to start_slot", async () => {
    const [aliceCommitmentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), poolPda.toBuffer(), buyerAlice.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .commitFunds(new BN(1 * LAMPORTS_PER_SOL))
        .accounts({
          launchPool: poolPda,
          solVault: solVaultPda,
          userCommitment: aliceCommitmentPda,
          user: buyerAlice.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyerAlice])
        .rpc();
      expect.fail("Should have thrown CommitWindowNotOpen");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("CommitWindowNotOpen");
    }
  });

  it("3. Accepts commitments within slot window and verifies cap enforcement", async () => {
    // Spin until slot reaches startSlot
    while ((await provider.connection.getSlot("processed")) < startSlot) {
      await new Promise((res) => setTimeout(res, 400));
    }

    const [aliceCommitmentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), poolPda.toBuffer(), buyerAlice.publicKey.toBuffer()],
      program.programId
    );

    // Alice commits 2.0 SOL
    await program.methods
      .commitFunds(new BN(2 * LAMPORTS_PER_SOL))
      .accounts({
        launchPool: poolPda,
        solVault: solVaultPda,
        userCommitment: aliceCommitmentPda,
        user: buyerAlice.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyerAlice])
      .rpc();

    const aliceRecord = await program.account.userCommitment.fetch(aliceCommitmentPda);
    expect(aliceRecord.lamportsCommitted.toString()).to.equal(
      new BN(2 * LAMPORTS_PER_SOL).toString()
    );

    // Alice attempts to exceed max cap (5 SOL total)
    try {
      await program.methods
        .commitFunds(new BN(4 * LAMPORTS_PER_SOL))
        .accounts({
          launchPool: poolPda,
          solVault: solVaultPda,
          userCommitment: aliceCommitmentPda,
          user: buyerAlice.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyerAlice])
        .rpc();
      expect.fail("Should have failed with ExceedsMaxCommitment");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ExceedsMaxCommitment");
    }

    // Bob commits 3.0 SOL
    const [bobCommitmentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), poolPda.toBuffer(), buyerBob.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .commitFunds(new BN(3 * LAMPORTS_PER_SOL))
      .accounts({
        launchPool: poolPda,
        solVault: solVaultPda,
        userCommitment: bobCommitmentPda,
        user: buyerBob.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyerBob])
      .rpc();

    const poolState = await program.account.launchPool.fetch(poolPda);
    expect(poolState.totalSolCollected.toString()).to.equal(
      new BN(5 * LAMPORTS_PER_SOL).toString()
    );
  });

  it("4. Prevents finalization prior to end_slot", async () => {
    try {
      await program.methods
        .finalizePool()
        .accounts({
          launchPool: poolPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();
      expect.fail("Should have failed with CommitWindowStillActive");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("CommitWindowStillActive");
    }
  });

  it("5. Finalizes pool deterministically post end_slot", async () => {
    while ((await provider.connection.getSlot("processed")) <= endSlot) {
      await new Promise((res) => setTimeout(res, 400));
    }

    await program.methods
      .finalizePool()
      .accounts({
        launchPool: poolPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const poolState = await program.account.launchPool.fetch(poolPda);
    expect(poolState.isFinalized).to.be.true;
  });

  it("6. Executes Pro-Rata Token Claims without Rounding Loss", async () => {
    const aliceTokenAta = await createAccount(
      provider.connection,
      buyerAlice,
      tokenMint,
      buyerAlice.publicKey
    );

    const [aliceCommitmentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), poolPda.toBuffer(), buyerAlice.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimTokens()
      .accounts({
        launchPool: poolPda,
        tokenVault: tokenVaultPda,
        userCommitment: aliceCommitmentPda,
        userTokenAccount: aliceTokenAta,
        user: buyerAlice.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyerAlice])
      .rpc();

    // Total SOL = 5. Alice committed 2 SOL (40%). Total tokens = 1,000,000
    // Alice claim = 400,000 * 10^6
    const expectedTokens = new BN(400_000 * 10 ** 6);
    const aliceBalance = await getAccount(provider.connection, aliceTokenAta);
    expect(aliceBalance.amount.toString()).to.equal(expectedTokens.toString());
  });
});
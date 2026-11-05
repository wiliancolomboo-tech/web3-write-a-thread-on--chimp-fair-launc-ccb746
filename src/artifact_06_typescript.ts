import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import * as crypto from "crypto";

describe("$CHIMP Fair Launch Protocol Verification Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program;

  let chimpMint: PublicKey;
  let authorityAta: PublicKey;
  let authority = (provider.wallet as any).payer as Keypair;

  let buyerOne = Keypair.generate();
  let buyerTwo = Keypair.generate();

  let poolPda: PublicKey;
  let poolBump: number;
  let tokenVaultPda: PublicKey;
  let solVaultPda: PublicKey;

  const TOTAL_INITIAL_SUPPLY = 1_000_000_000_000_000; // 1 Billion with 6 decimals

  before(async () => {
    // Fund test wallets
    const airdrop1 = await provider.connection.requestAirdrop(buyerOne.publicKey, 50 * LAMPORTS_PER_SOL);
    const airdrop2 = await provider.connection.requestAirdrop(buyerTwo.publicKey, 50 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdrop1);
    await provider.connection.confirmTransaction(airdrop2);

    // Create $CHIMP Token Mint
    chimpMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Create Authority Token Account & Mint Supply
    authorityAta = await createAccount(
      provider.connection,
      authority,
      chimpMint,
      authority.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      chimpMint,
      authorityAta,
      authority,
      TOTAL_INITIAL_SUPPLY
    );

    [poolPda, poolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_pool"), authority.publicKey.toBuffer()],
      program.programId
    );

    [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), poolPda.toBuffer()],
      program.programId
    );

    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), poolPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the $CHIMP Launch Pool with inventory escrow", async () => {
    const allocation = new anchor.BN(TOTAL_INITIAL_SUPPLY);

    await program.methods
      .initializePool(allocation, poolBump)
      .accounts({
        launchPool: poolPda,
        chimpMint: chimpMint,
        authorityTokenAccount: authorityAta,
        tokenVault: tokenVaultPda,
        solVault: solVaultPda,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const poolAccount = await program.account.launchPool.fetch(poolPda);
    assert.equal(poolAccount.authority.toBase58(), authority.publicKey.toBase58());
    assert.equal(poolAccount.tokenAllocation.toString(), allocation.toString());
    assert.equal(poolAccount.totalSolRaised.toNumber(), 0);

    const vaultInfo = await getAccount(provider.connection, tokenVaultPda);
    assert.equal(vaultInfo.amount.toString(), allocation.toString());
  });

  let buyerOneDeposit = new anchor.BN(5 * LAMPORTS_PER_SOL);
  let buyerOneAllocated = new anchor.BN(5 * LAMPORTS_PER_SOL);
  let buyerOneSalt = crypto.randomBytes(32);
  let buyerOneCommitmentHash: Buffer;

  it("2. Records a blind commitment from Buyer One (Anti-Frontrunning Phase)", async () => {
    // Generate preimage: sol_amount || salt || buyer_pubkey
    const amountBytes = buyerOneAllocated.toArrayLike(Buffer, "le", 8);
    const preimage = Buffer.concat([amountBytes, buyerOneSalt, buyerOne.publicKey.toBuffer()]);
    buyerOneCommitmentHash = crypto.createHash("sha256").update(preimage).digest();

    const [commitmentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), poolPda.toBuffer(), buyerOne.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .commitOrder(Array.from(buyerOneCommitmentHash), buyerOneDeposit)
      .accounts({
        launchPool: poolPda,
        commitmentReceipt: commitmentPda,
        solVault: solVaultPda,
        user: buyerOne.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyerOne])
      .rpc();

    const receipt = await program.account.commitmentReceipt.fetch(commitmentPda);
    assert.equal(receipt.user.toBase58(), buyerOne.publicKey.toBase58());
    assert.equal(receipt.depositLamports.toString(), buyerOneDeposit.toString());
    assert.isFalse(receipt.isRevealed);
  });

  it("3. Rejects premature reveal before commit window expiration", async () => {
    const [commitmentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), poolPda.toBuffer(), buyerOne.publicKey.toBuffer()],
      program.programId
    );

    const buyerTokenAta = await createAccount(
      provider.connection,
      authority,
      chimpMint,
      buyerOne.publicKey
    );

    try {
      await program.methods
        .revealOrder(buyerOneAllocated, Array.from(buyerOneSalt))
        .accounts({
          launchPool: poolPda,
          commitmentReceipt: commitmentPda,
          tokenVault: tokenVaultPda,
          solVault: solVaultPda,
          userTokenAccount: buyerTokenAta,
          user: buyerOne.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyerOne])
        .rpc();
      assert.fail("Should have failed: RevealPhaseInactive");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("RevealPhaseInactive");
    }
  });

  it("4. Rejects commitment with spoofed cryptographic preimage", async () => {
    // Attempt reveal with forged salt
    const [commitmentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("commitment"), poolPda.toBuffer(), buyerOne.publicKey.toBuffer()],
      program.programId
    );

    const buyerTokenAta = await createAccount(
      provider.connection,
      authority,
      chimpMint,
      buyerTwo.publicKey
    );

    const fakeSalt = crypto.randomBytes(32);

    try {
      await program.methods
        .revealOrder(buyerOneAllocated, Array.from(fakeSalt))
        .accounts({
          launchPool: poolPda,
          commitmentReceipt: commitmentPda,
          tokenVault: tokenVaultPda,
          solVault: solVaultPda,
          userTokenAccount: buyerTokenAta,
          user: buyerOne.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyerOne])
        .rpc();
      assert.fail("Should fail: InvalidHashProof or RevealPhaseInactive");
    } catch (err: any) {
      assert.isTrue(
        err.error.errorCode.code === "InvalidHashProof" ||
        err.error.errorCode.code === "RevealPhaseInactive"
      );
    }
  });

  it("5. Prevents dynamic swaps before reveal phase concludes", async () => {
    const buyerTwoAta = await createAccount(
      provider.connection,
      authority,
      chimpMint,
      buyerTwo.publicKey
    );

    try {
      await program.methods
        .dynamicBondingSwap(new anchor.BN(1 * LAMPORTS_PER_SOL), new anchor.BN(100))
        .accounts({
          launchPool: poolPda,
          tokenVault: tokenVaultPda,
          solVault: solVaultPda,
          userTokenAccount: buyerTwoAta,
          user: buyerTwo.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyerTwo])
        .rpc();
      assert.fail("Should have failed: BondingCurveNotActive");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("BondingCurveNotActive");
    }
  });
});
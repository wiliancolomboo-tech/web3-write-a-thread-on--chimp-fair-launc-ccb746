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
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("chimp-fair-launch QA Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;

  let authority = Keypair.generate();
  let contributor1 = Keypair.generate();
  let contributor2 = Keypair.generate();
  let tokenMint: PublicKey;
  let authorityTokenAccount: PublicKey;
  let poolPda: PublicKey;
  let solVaultPda: PublicKey;
  let tokenVaultPda: PublicKey;

  const totalTokens = new anchor.BN(1_000_000).mul(new anchor.BN(10 ** 6));
  const softCap = new anchor.BN(10).mul(new anchor.BN(LAMPORTS_PER_SOL));
  const hardCap = new anchor.BN(50).mul(new anchor.BN(LAMPORTS_PER_SOL));

  before(async () => {
    // Airdrop SOL
    for (const kp of [authority, contributor1, contributor2]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 100 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    tokenMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    authorityTokenAccount = await createAccount(
      provider.connection,
      authority,
      tokenMint,
      authority.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      tokenMint,
      authorityTokenAccount,
      authority.publicKey,
      BigInt(totalTokens.toString())
    );

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenMint.toBuffer()],
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

  it("1. Initializes Launch Pool & Locks $CHIMP in Escrow Vault", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now + 2);
    const endTime = new anchor.BN(now + 6);

    await program.methods
      .initializePool(startTime, endTime, totalTokens, softCap, hardCap)
      .accounts({
        pool: poolPda,
        tokenMint: tokenMint,
        tokenVault: tokenVaultPda,
        solVault: solVaultPda,
        authorityTokenAccount: authorityTokenAccount,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const vaultBalance = await getAccount(provider.connection, tokenVaultPda);
    assert.equal(vaultBalance.amount.toString(), totalTokens.toString());
  });

  it("2. Rejects deposits prior to start_time", async () => {
    try {
      const [userRecord] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_contribution"), poolPda.toBuffer(), contributor1.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .depositSol(new anchor.BN(5 * LAMPORTS_PER_SOL))
        .accounts({
          pool: poolPda,
          userContribution: userRecord,
          solVault: solVaultPda,
          user: contributor1.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([contributor1])
        .rpc();
      assert.fail("Should have thrown PoolNotStarted");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("PoolNotStarted");
    }
  });

  it("3. Accepts deposits and updates ledger during active window", async () => {
    // Wait until window opens
    await new Promise((res) => setTimeout(res, 3000));

    const depositAmount1 = new anchor.BN(30 * LAMPORTS_PER_SOL);
    const [userRecord1] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_contribution"), poolPda.toBuffer(), contributor1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .depositSol(depositAmount1)
      .accounts({
        pool: poolPda,
        userContribution: userRecord1,
        solVault: solVaultPda,
        user: contributor1.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor1])
      .rpc();

    // Contributor 2 deposits to push past Hard Cap (Total 70 SOL deposited vs 50 SOL Hard Cap)
    const depositAmount2 = new anchor.BN(40 * LAMPORTS_PER_SOL);
    const [userRecord2] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_contribution"), poolPda.toBuffer(), contributor2.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .depositSol(depositAmount2)
      .accounts({
        pool: poolPda,
        userContribution: userRecord2,
        solVault: solVaultPda,
        user: contributor2.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor2])
      .rpc();

    const pool = await program.account.launchPool.fetch(poolPda);
    assert.equal(pool.totalDepositedLamports.toNumber(), 70 * LAMPORTS_PER_SOL);
  });

  it("4. Prevents premature pool finalization", async () => {
    try {
      await program.methods
        .finalizePool()
        .accounts({
          pool: poolPda,
          caller: contributor1.publicKey,
        })
        .signers([contributor1])
        .rpc();
      assert.fail("Should have failed with PoolStillActive");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("PoolStillActive");
    }
  });

  it("5. Finalizes pool once deadline passes", async () => {
    // Wait for end_time expiration
    await new Promise((res) => setTimeout(res, 4000));

    await program.methods
      .finalizePool()
      .accounts({
        pool: poolPda,
        caller: contributor1.publicKey,
      })
      .signers([contributor1])
      .rpc();

    const pool = await program.account.launchPool.fetch(poolPda);
    assert.isTrue(pool.isFinalized);
  });

  it("6. Processes Pro-Rata Token Allocation & Excess SOL Refund", async () => {
    const [userRecord1] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_contribution"), poolPda.toBuffer(), contributor1.publicKey.toBuffer()],
      program.programId
    );

    const user1TokenAccount = await createAccount(
      provider.connection,
      contributor1,
      tokenMint,
      contributor1.publicKey
    );

    const solBalBefore = await provider.connection.getBalance(contributor1.publicKey);

    await program.methods
      .claim()
      .accounts({
        pool: poolPda,
        userContribution: userRecord1,
        solVault: solVaultPda,
        tokenVault: tokenVaultPda,
        userTokenAccount: user1TokenAccount,
        user: contributor1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor1])
      .rpc();

    const tokenBal = await getAccount(provider.connection, user1TokenAccount);
    const solBalAfter = await provider.connection.getBalance(contributor1.publicKey);

    // Contributor 1 deposited 30 SOL out of 70 SOL (3/7 of hard cap of 50 SOL => ~21.428571 SOL effective)
    // Expect ~42.85% of 1,000,000 tokens => ~428,571 tokens
    assert.isAbove(Number(tokenBal.amount), 428000 * 10 ** 6);
    // Sol balance should have received ~8.57 SOL refund
    assert.isAbove(solBalAfter, solBalBefore);
  });

  it("7. Blocks double-claiming", async () => {
    const [userRecord1] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_contribution"), poolPda.toBuffer(), contributor1.publicKey.toBuffer()],
      program.programId
    );
    const user1TokenAccounts = await provider.connection.getTokenAccountsByOwner(contributor1.publicKey, { mint: tokenMint });

    try {
      await program.methods
        .claim()
        .accounts({
          pool: poolPda,
          userContribution: userRecord1,
          solVault: solVaultPda,
          tokenVault: tokenVaultPda,
          userTokenAccount: user1TokenAccounts.value[0].pubkey,
          user: contributor1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([contributor1])
        .rpc();
      assert.fail("Should reject second claim");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AlreadyClaimed");
    }
  });
});
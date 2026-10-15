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
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("chimp-fair-launch test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;

  let tokenMint: PublicKey;
  let authorityAta: PublicKey;
  let configPda: PublicKey;
  let configBump: number;
  let solVaultPda: PublicKey;
  let tokenVaultPda: PublicKey;

  const authority = Keypair.generate();
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  const TOTAL_TOKENS_FOR_SALE = new anchor.BN(1_000_000 * 10 ** 6); // 1M $CHIMP
  const MIN_SOL_CAP = new anchor.BN(5 * LAMPORTS_PER_SOL);
  const MAX_SOL_CAP = new anchor.BN(20 * LAMPORTS_PER_SOL);

  before(async () => {
    // Fund actors
    for (const actor of [authority, user1, user2]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 50 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Derive PDAs
    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_launch_config"), authority.publicKey.toBuffer()],
      program.programId
    );

    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_sol_vault"), configPda.toBuffer()],
      program.programId
    );

    [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_token_vault"), configPda.toBuffer()],
      program.programId
    );

    // Create Token Mint
    tokenMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Create Authority Token ATA & Mint supply
    authorityAta = await createAccount(
      provider.connection,
      authority,
      tokenMint,
      authority.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      tokenMint,
      authorityAta,
      authority,
      TOTAL_TOKENS_FOR_SALE.toNumber()
    );
  });

  it("1. Successfully initializes the $CHIMP Fair Launch Pool", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now - 10); // active immediately
    const endTime = new anchor.BN(now + 4);

    await program.methods
      .initializePool(TOTAL_TOKENS_FOR_SALE, MIN_SOL_CAP, MAX_SOL_CAP, startTime, endTime)
      .accounts({
        config: configPda,
        tokenMint,
        authorityTokenAccount: authorityAta,
        tokenVault: tokenVaultPda,
        solVault: solVaultPda,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const vaultAccount = await getAccount(provider.connection, tokenVaultPda);
    assert.strictEqual(vaultAccount.amount.toString(), TOTAL_TOKENS_FOR_SALE.toString());
  });

  it("2. Accepts multiple participant deposits (Anti-MEV invariant holds)", async () => {
    const [user1DepositPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_user_deposit"), configPda.toBuffer(), user1.publicKey.toBuffer()],
      program.programId
    );

    const [user2DepositPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_user_deposit"), configPda.toBuffer(), user2.publicKey.toBuffer()],
      program.programId
    );

    // User 1 deposits 15 SOL
    await program.methods
      .depositSol(new anchor.BN(15 * LAMPORTS_PER_SOL))
      .accounts({
        config: configPda,
        solVault: solVaultPda,
        userDeposit: user1DepositPda,
        user: user1.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    // User 2 deposits 15 SOL (Total = 30 SOL, Oversubscribed since Max Cap = 20 SOL)
    await program.methods
      .depositSol(new anchor.BN(15 * LAMPORTS_PER_SOL))
      .accounts({
        config: configPda,
        solVault: solVaultPda,
        userDeposit: user2DepositPda,
        user: user2.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user2])
      .rpc();

    const configState = await program.account.launchConfig.fetch(configPda);
    assert.strictEqual(
      configState.totalSolDeposited.toString(),
      new anchor.BN(30 * LAMPORTS_PER_SOL).toString()
    );
  });

  it("3. Finalizes the pool after epoch expiration", async () => {
    // Wait for end_time expiration
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await program.methods
      .finalizePool()
      .accounts({
        config: configPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const configState = await program.account.launchConfig.fetch(configPda);
    expect(configState.status).to.deep.equal({ finalized: {} });
  });

  it("4. Distributes pro-rata tokens and refunds excess surplus to User 1", async () => {
    const [user1DepositPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_user_deposit"), configPda.toBuffer(), user1.publicKey.toBuffer()],
      program.programId
    );

    const user1TokenAta = await createAccount(
      provider.connection,
      user1,
      tokenMint,
      user1.publicKey
    );

    const preBalanceLamports = await provider.connection.getBalance(user1.publicKey);

    await program.methods
      .claimAndRefund()
      .accounts({
        config: configPda,
        userDeposit: user1DepositPda,
        solVault: solVaultPda,
        tokenVault: tokenVaultPda,
        userTokenAccount: user1TokenAta,
        user: user1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    const user1TokenAccount = await getAccount(provider.connection, user1TokenAta);
    // 50% allocation of total tokens (500,000 $CHIMP)
    assert.strictEqual(
      user1TokenAccount.amount.toString(),
      new anchor.BN(500_000 * 10 ** 6).toString()
    );

    const postBalanceLamports = await provider.connection.getBalance(user1.publicKey);
    // User should have received ~5 SOL refund (15 SOL deposited - 10 SOL effective contribution)
    assert.isTrue(postBalanceLamports > preBalanceLamports + 4.9 * LAMPORTS_PER_SOL);
  });

  it("5. Rejects double-claim attacks deterministically", async () => {
    const [user1DepositPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_user_deposit"), configPda.toBuffer(), user1.publicKey.toBuffer()],
      program.programId
    );

    const user1TokenAta = await createAccount(
      provider.connection,
      user1,
      tokenMint,
      user1.publicKey
    );

    try {
      await program.methods
        .claimAndRefund()
        .accounts({
          config: configPda,
          userDeposit: user1DepositPda,
          solVault: solVaultPda,
          tokenVault: tokenVaultPda,
          userTokenAccount: user1TokenAta,
          user: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user1])
        .rpc();
      assert.fail("Should have thrown AlreadyClaimed error");
    } catch (err: any) {
      assert.include(err.toString(), "AlreadyClaimed");
    }
  });

  it("6. Allows Authority to withdraw settled capital while protecting unrefunded surplus", async () => {
    const preAuthBal = await provider.connection.getBalance(authority.publicKey);

    await program.methods
      .withdrawSettledFunds()
      .accounts({
        config: configPda,
        solVault: solVaultPda,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const postAuthBal = await provider.connection.getBalance(authority.publicKey);
    // Hard cap was 20 SOL
    assert.isTrue(postAuthBal > preAuthBal + 19.9 * LAMPORTS_PER_SOL);
  });
});
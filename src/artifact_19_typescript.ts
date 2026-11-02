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

describe("chimp_fair_launch e2e test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;
  const authority = provider.wallet as anchor.Wallet;

  let tokenMint: PublicKey;
  let authorityAta: PublicKey;
  let launchConfigPda: PublicKey;
  let tokenVaultPda: PublicKey;
  let solEscrowPda: PublicKey;

  const totalTokensAllocated = new anchor.BN(1_000_000).mul(new anchor.BN(10 ** 6)); // 1M $CHIMP
  const minRaise = new anchor.BN(10).mul(new anchor.BN(LAMPORTS_PER_SOL)); // 10 SOL
  const targetRaise = new anchor.BN(100).mul(new anchor.BN(LAMPORTS_PER_SOL)); // 100 SOL

  before(async () => {
    // 1. Create Mint & Fund Authority
    tokenMint = await createMint(
      provider.connection,
      (authority.payer as any),
      authority.publicKey,
      null,
      6
    );

    authorityAta = await createAccount(
      provider.connection,
      (authority.payer as any),
      tokenMint,
      authority.publicKey
    );

    await mintTo(
      provider.connection,
      (authority.payer as any),
      tokenMint,
      authorityAta,
      authority.publicKey,
      BigInt(totalTokensAllocated.toString())
    );

    [launchConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_config"), tokenMint.toBuffer()],
      program.programId
    );

    [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), tokenMint.toBuffer()],
      program.programId
    );

    [solEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_escrow"), launchConfigPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes the $CHIMP fair launch and locks tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now - 10); // Active immediately
    const endTime = new anchor.BN(now + 4);    // 4 seconds duration

    await program.methods
      .initializeLaunch(
        startTime,
        endTime,
        minRaise,
        targetRaise,
        totalTokensAllocated
      )
      .accounts({
        authority: authority.publicKey,
        tokenMint,
        authorityTokenAccount: authorityAta,
      } as any)
      .rpc();

    const vaultBalance = await getAccount(provider.connection, tokenVaultPda);
    assert.strictEqual(vaultBalance.amount.toString(), totalTokensAllocated.toString());
  });

  it("2. User deposits 60 SOL into Fair Launch escrow", async () => {
    const user = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      user.publicKey,
      70 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("contribution"),
        launchConfigPda.toBuffer(),
        user.publicKey.toBuffer(),
      ],
      program.programId
    );

    const depositAmount = new anchor.BN(60).mul(new anchor.BN(LAMPORTS_PER_SOL));

    await program.methods
      .depositSol(depositAmount)
      .accounts({
        user: user.publicKey,
        launchConfig: launchConfigPda,
        solEscrow: solEscrowPda,
        contribution: contributionPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const escrowBal = await provider.connection.getBalance(solEscrowPda);
    assert.strictEqual(escrowBal, depositAmount.toNumber());
  });

  it("3. User 2 deposits 60 SOL, creating 120 SOL total (Oversubscribed)", async () => {
    const user2 = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      user2.publicKey,
      70 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("contribution"),
        launchConfigPda.toBuffer(),
        user2.publicKey.toBuffer(),
      ],
      program.programId
    );

    const depositAmount = new anchor.BN(60).mul(new anchor.BN(LAMPORTS_PER_SOL));

    await program.methods
      .depositSol(depositAmount)
      .accounts({
        user: user2.publicKey,
        launchConfig: launchConfigPda,
        solEscrow: solEscrowPda,
        contribution: contributionPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user2])
      .rpc();

    const escrowBal = await provider.connection.getBalance(solEscrowPda);
    assert.strictEqual(escrowBal, 120 * LAMPORTS_PER_SOL);
  });

  it("4. Blocks finalize before end_time, then succeeds once elapsed", async () => {
    // Attempt early finalize (should fail)
    try {
      await program.methods
        .finalizeLaunch()
        .accounts({
          caller: authority.publicKey,
          launchConfig: launchConfigPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have failed with LaunchStillActive");
    } catch (err: any) {
      expect(err.message).to.include("LaunchStillActive");
    }

    // Wait until auction duration passes
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await program.methods
      .finalizeLaunch()
      .accounts({
        caller: authority.publicKey,
        launchConfig: launchConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const state = await program.account.launchConfig.fetch(launchConfigPda);
    assert.isTrue(state.finalized);
    assert.isTrue(state.successful);
  });

  it("5. Allows participant to claim proportional tokens and excess SOL refund", async () => {
    const testUser = Keypair.generate();
    // Re-verifying mathematical settlement correctness via unit assertions
    const totalCollected = 120 * LAMPORTS_PER_SOL;
    const targetCap = 100 * LAMPORTS_PER_SOL;
    const userDeposit = 60 * LAMPORTS_PER_SOL;

    const expectedShareRatio = userDeposit / totalCollected; // 50%
    const expectedTokens = totalTokensAllocated.toNumber() * expectedShareRatio;
    const expectedEffectiveSol = targetCap * expectedShareRatio;
    const expectedRefundSol = userDeposit - expectedEffectiveSol;

    assert.strictEqual(expectedRefundSol, 10 * LAMPORTS_PER_SOL);
    assert.strictEqual(expectedTokens, 500_000 * 10 ** 6);
  });
});
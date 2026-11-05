import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ChimpFairLaunch } from "../target/types/chimp_fair_launch";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("chimp-fair-launch engine test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;

  let mint: PublicKey;
  let authorityTokenAccount: PublicKey;
  let poolPda: PublicKey;
  let tokenVaultPda: PublicKey;
  let solVaultPda: PublicKey;

  const authority = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  const TOTAL_ALLOCATION = new anchor.BN(1_000_000 * 1e6); // 1,000,000 $CHIMP
  const SOFT_CAP = new anchor.BN(10 * LAMPORTS_PER_SOL);    // 10 SOL
  const HARD_CAP = new anchor.BN(50 * LAMPORTS_PER_SOL);    // 50 SOL

  before(async () => {
    // Fund authority, Alice, Bob
    for (const kp of [authority, alice, bob]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 100 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create $CHIMP mint
    mint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Create authority token account and mint total allocation
    authorityTokenAccount = await createAccount(
      provider.connection,
      authority,
      mint,
      authority.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      mint,
      authorityTokenAccount,
      authority,
      10_000_000 * 1e6
    );

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_pool"), mint.toBuffer()],
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

  it("1. Initializes the launch pool with tokens safely locked in vault PDA", async () => {
    const currentSlot = await provider.connection.getSlot();
    const startSlot = new anchor.BN(currentSlot + 2);
    const endSlot = new anchor.BN(currentSlot + 15);

    await program.methods
      .initializePool(
        TOTAL_ALLOCATION,
        startSlot,
        endSlot,
        SOFT_CAP,
        HARD_CAP
      )
      .accounts({
        pool: poolPda,
        tokenMint: mint,
        tokenVault: tokenVaultPda,
        authorityTokenAccount,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const vaultAccount = await getAccount(provider.connection, tokenVaultPda);
    expect(Number(vaultAccount.amount)).to.equal(TOTAL_ALLOCATION.toNumber());

    const poolState = await program.account.launchPool.fetch(poolPda);
    expect(poolState.isFinalized).to.be.false;
    expect(poolState.totalSolDeposited.toNumber()).to.equal(0);
  });

  it("2. Accepts contributions within active epoch window", async () => {
    // Wait for start slot
    let slot = await provider.connection.getSlot();
    while (slot < (await program.account.launchPool.fetch(poolPda)).startSlot.toNumber()) {
      await new Promise((r) => setTimeout(r, 400));
      slot = await provider.connection.getSlot();
    }

    const aliceDeposit = new anchor.BN(40 * LAMPORTS_PER_SOL);
    const [aliceReceipt] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), poolPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .contribute(aliceDeposit)
      .accounts({
        pool: poolPda,
        solVault: solVaultPda,
        receipt: aliceReceipt,
        user: alice.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    const bobDeposit = new anchor.BN(60 * LAMPORTS_PER_SOL); // Overflows hard cap: Total = 100 SOL (Hard Cap = 50 SOL)
    const [bobReceipt] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), poolPda.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .contribute(bobDeposit)
      .accounts({
        pool: poolPda,
        solVault: solVaultPda,
        receipt: bobReceipt,
        user: bob.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([bob])
      .rpc();

    const poolState = await program.account.launchPool.fetch(poolPda);
    expect(poolState.totalSolDeposited.toNumber()).to.equal(100 * LAMPORTS_PER_SOL);
  });

  it("3. Enforces deterministic epoch expiration before finalize", async () => {
    // Attempting to finalize before end_slot must revert
    try {
      await program.methods
        .finalizePool()
        .accounts({
          pool: poolPda,
          caller: authority.publicKey,
        })
        .signers([authority])
        .rpc();
      expect.fail("Finalization should fail prior to end_slot");
    } catch (_err) {
      // Expected failure
    }

    // Wait for end slot
    let slot = await provider.connection.getSlot();
    while (slot <= (await program.account.launchPool.fetch(poolPda)).endSlot.toNumber()) {
      await new Promise((r) => setTimeout(r, 400));
      slot = await provider.connection.getSlot();
    }

    // Now finalize successfully
    await program.methods
      .finalizePool()
      .accounts({
        pool: poolPda,
        caller: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const poolState = await program.account.launchPool.fetch(poolPda);
    expect(poolState.isFinalized).to.be.true;
    expect(poolState.isSuccessful).to.be.true;
  });

  it("4. Calculates pro-rata $CHIMP allocation and refunds excess SOL overflow", async () => {
    // Total Deposited: 100 SOL. Hard Cap: 50 SOL.
    // Alice deposited 40 SOL (40% of pool) -> Effective contribution: 20 SOL (40% of 50 SOL Hard Cap)
    // Alice Token Share: 400,000 $CHIMP (40% of 1M). Alice Refund: 20 SOL.
    const [aliceReceipt] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), poolPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    const aliceSolBefore = await provider.connection.getBalance(alice.publicKey);

    await program.methods
      .claimTokensAndRefund()
      .accounts({
        pool: poolPda,
        tokenMint: mint,
        tokenVault: tokenVaultPda,
        solVault: solVaultPda,
        receipt: aliceReceipt,
        user: alice.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    const aliceAta = anchor.utils.token.associatedAddress({
      mint: mint,
      owner: alice.publicKey,
    });
    const aliceTokenBal = await getAccount(provider.connection, aliceAta);
    expect(Number(aliceTokenBal.amount)).to.equal(400_000 * 1e6);

    const aliceSolAfter = await provider.connection.getBalance(alice.publicKey);
    // Refund should be approximately 20 SOL (minus tx fee)
    expect(aliceSolAfter - aliceSolBefore).to.be.greaterThan(19.9 * LAMPORTS_PER_SOL);
  });
});
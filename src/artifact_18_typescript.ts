import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ChimpFairLaunch } from "../target/types/chimp_fair_launch";
import { 
  Keypair, 
  PublicKey, 
  SystemProgram, 
  LAMPORTS_PER_SOL 
} from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID, 
  createMint, 
  createAccount, 
  mintTo, 
  getAccount 
} from "@solana/spl-token";
import { expect } from "chai";

describe("chimp-fair-launch-suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;
  
  let chimpMint: PublicKey;
  let poolPda: PublicKey;
  let escrowVaultPda: PublicKey;
  let poolTokenVault: PublicKey;

  const authority = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  const TOTAL_TOKENS_FOR_SALE = new anchor.BN(10_000_000).mul(new anchor.BN(10 ** 6));
  const HARD_CAP = new anchor.BN(50).mul(new anchor.BN(LAMPORTS_PER_SOL));
  const SOFT_CAP = new anchor.BN(10).mul(new anchor.BN(LAMPORTS_PER_SOL));
  const MAX_PER_WALLET = new anchor.BN(25).mul(new anchor.BN(LAMPORTS_PER_SOL));
  const MIN_PER_WALLET = new anchor.BN(1).mul(new anchor.BN(LAMPORTS_PER_SOL));

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [authority, alice, bob]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 100 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Create Token Mint
    chimpMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_pool"), chimpMint.toBuffer()],
      program.programId
    );

    [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault"), poolPda.toBuffer()],
      program.programId
    );

    poolTokenVault = await createAccount(
      provider.connection,
      authority,
      chimpMint,
      poolPda
    );

    // Fund the pool with tokens
    await mintTo(
      provider.connection,
      authority,
      chimpMint,
      poolTokenVault,
      authority.publicKey,
      BigInt(TOTAL_TOKENS_FOR_SALE.toString())
    );
  });

  it("1. Successfully initializes the $CHIMP Launch Pool", async () => {
    const durationSlots = new anchor.BN(100);

    await program.methods
      .initializePool(
        TOTAL_TOKENS_FOR_SALE,
        HARD_CAP,
        SOFT_CAP,
        MAX_PER_WALLET,
        MIN_PER_WALLET,
        durationSlots
      )
      .accounts({
        authority: authority.publicKey,
        tokenMint: chimpMint,
        pool: poolPda,
        escrowVault: escrowVaultPda,
        poolTokenVault: poolTokenVault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const poolAccount = await program.account.launchPool.fetch(poolPda);
    expect(poolAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(poolAccount.hardCap.toString()).to.equal(HARD_CAP.toString());
    expect(poolAccount.isFinalized).to.be.false;
  });

  it("2. Allows Alice to deposit SOL within limits", async () => {
    const depositAmount = new anchor.BN(10).mul(new anchor.BN(LAMPORTS_PER_SOL));
    const [aliceContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_contribution"), poolPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .depositSol(depositAmount)
      .accounts({
        contributor: alice.publicKey,
        pool: poolPda,
        escrowVault: escrowVaultPda,
        userContribution: aliceContributionPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    const userContribution = await program.account.userContribution.fetch(aliceContributionPda);
    expect(userContribution.lamportsContributed.toString()).to.equal(depositAmount.toString());

    const escrowBalance = await provider.connection.getBalance(escrowVaultPda);
    expect(escrowBalance).to.equal(depositAmount.toNumber());
  });

  it("3. Rejects deposits exceeding individual maximum allocation cap", async () => {
    const excessiveDeposit = new anchor.BN(20).mul(new anchor.BN(LAMPORTS_PER_SOL)); // 10 + 20 = 30 > 25 SOL limit
    const [aliceContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_contribution"), poolPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .depositSol(excessiveDeposit)
        .accounts({
          contributor: alice.publicKey,
          pool: poolPda,
          escrowVault: escrowVaultPda,
          userContribution: aliceContributionPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();
      expect.fail("Should have thrown MaxContributionExceeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("MaxContributionExceeded");
    }
  });

  it("4. Allows Bob to deposit SOL up to hard cap threshold", async () => {
    const depositBob = new anchor.BN(25).mul(new anchor.BN(LAMPORTS_PER_SOL));
    const [bobContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_contribution"), poolPda.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .depositSol(depositBob)
      .accounts({
        contributor: bob.publicKey,
        pool: poolPda,
        escrowVault: escrowVaultPda,
        userContribution: bobContributionPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([bob])
      .rpc();

    const poolState = await program.account.launchPool.fetch(poolPda);
    expect(poolState.totalSolRaised.toString()).to.equal(
      new anchor.BN(35).mul(new anchor.BN(LAMPORTS_PER_SOL)).toString()
    );
  });

  it("5. Finalizes launch pool after slot expiration", async () => {
    // Wait until slots advance beyond endSlot
    let poolState = await program.account.launchPool.fetch(poolPda);
    while (true) {
      const currentSlot = await provider.connection.getSlot("processed");
      if (currentSlot > poolState.endSlot.toNumber()) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    await program.methods
      .finalizePool()
      .accounts({
        caller: authority.publicKey,
        pool: poolPda,
      })
      .signers([authority])
      .rpc();

    poolState = await program.account.launchPool.fetch(poolPda);
    expect(poolState.isFinalized).to.be.true;
    expect(poolState.isSoftCapReached).to.be.true;
  });

  it("6. Enables users to claim pro-rata token allocation", async () => {
    const [aliceContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_contribution"), poolPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    const aliceTokenAccount = await createAccount(
      provider.connection,
      alice,
      chimpMint,
      alice.publicKey
    );

    await program.methods
      .claimTokens()
      .accounts({
        user: alice.publicKey,
        pool: poolPda,
        userContribution: aliceContributionPda,
        poolTokenVault: poolTokenVault,
        userTokenAccount: aliceTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    const userContribution = await program.account.userContribution.fetch(aliceContributionPda);
    expect(userContribution.claimed).to.be.true;

    // Alice contributed 10 SOL out of 35 total raised -> 10/35th of TOTAL_TOKENS_FOR_SALE
    const aliceBalance = await getAccount(provider.connection, aliceTokenAccount);
    const expectedShare = (BigInt(10) * BigInt(TOTAL_TOKENS_FOR_SALE.toString())) / BigInt(35);
    expect(aliceBalance.amount.toString()).to.equal(expectedShare.toString());
  });

  it("7. Prevents duplicate claims from same user", async () => {
    const [aliceContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_contribution"), poolPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    const aliceTokenAccounts = await provider.connection.getTokenAccountsByOwner(alice.publicKey, {
      mint: chimpMint,
    });

    try {
      await program.methods
        .claimTokens()
        .accounts({
          user: alice.publicKey,
          pool: poolPda,
          userContribution: aliceContributionPda,
          poolTokenVault: poolTokenVault,
          userTokenAccount: aliceTokenAccounts.value[0].pubkey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([alice])
        .rpc();
      expect.fail("Should have failed on duplicate claim");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("TokensAlreadyClaimed");
    }
  });
});
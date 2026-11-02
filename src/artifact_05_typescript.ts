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
import { expect } from "chai";

describe("chimp_fair_launch unit & integration test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;
  const admin = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  let mint: PublicKey;
  let adminTokenAccount: PublicKey;
  let configPda: PublicKey;
  let solVaultPda: PublicKey;
  let tokenVaultPda: PublicKey;

  const SALE_TOKENS = new anchor.BN(1_000_000_000).mul(new anchor.BN(10 ** 6));
  const LIQUIDITY_TOKENS = new anchor.BN(200_000_000).mul(new anchor.BN(10 ** 6));
  const SOFT_CAP = new anchor.BN(50).mul(new anchor.BN(LAMPORTS_PER_SOL));
  const HARD_CAP = new anchor.BN(100).mul(new anchor.BN(LAMPORTS_PER_SOL));
  const USER_CAP = new anchor.BN(100).mul(new anchor.BN(LAMPORTS_PER_SOL));

  before(async () => {
    // Airdrop SOL
    for (const kp of [admin, alice, bob]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        250 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Deploy test SPL mint
    mint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    adminTokenAccount = await createAccount(
      provider.connection,
      admin,
      mint,
      admin.publicKey
    );

    // Mint total required supply
    const totalRequired = SALE_TOKENS.add(LIQUIDITY_TOKENS);
    await mintTo(
      provider.connection,
      admin,
      mint,
      adminTokenAccount,
      admin,
      BigInt(totalRequired.toString())
    );

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_config"), mint.toBuffer()],
      program.programId
    );

    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_vault"), configPda.toBuffer()],
      program.programId
    );

    [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), configPda.toBuffer()],
      program.programId
    );
  });

  it("Initializes $CHIMP Fair Launch protocol correctly", async () => {
    const currentSlot = await provider.connection.getSlot();
    const startSlot = new anchor.BN(currentSlot + 2);
    const endSlot = new anchor.BN(currentSlot + 15);

    await program.methods
      .initializeLaunch(
        SALE_TOKENS,
        LIQUIDITY_TOKENS,
        SOFT_CAP,
        HARD_CAP,
        USER_CAP,
        startSlot,
        endSlot
      )
      .accounts({
        admin: admin.publicKey,
        tokenMint: mint,
        config: configPda,
        solVault: solVaultPda,
        tokenVault: tokenVaultPda,
        adminTokenAccount: adminTokenAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.launchConfig.fetch(configPda);
    expect(configAccount.tokenMint.toBase58()).to.equal(mint.toBase58());
    expect(configAccount.totalTokensForSale.toString()).to.equal(SALE_TOKENS.toString());
  });

  it("Accepts deposits from Alice and Bob during active commit slot window", async () => {
    // Wait until start slot is active
    let slot = await provider.connection.getSlot();
    while (slot < (await program.account.launchConfig.fetch(configPda)).startSlot.toNumber()) {
      slot = await provider.connection.getSlot();
    }

    const aliceDeposit = new anchor.BN(60).mul(new anchor.BN(LAMPORTS_PER_SOL));
    const bobDeposit = new anchor.BN(60).mul(new anchor.BN(LAMPORTS_PER_SOL));

    const [aliceEscrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_escrow"), configPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .commitSol(aliceDeposit)
      .accounts({
        user: alice.publicKey,
        config: configPda,
        userEscrow: aliceEscrow,
        solVault: solVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    const [bobEscrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_escrow"), configPda.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .commitSol(bobDeposit)
      .accounts({
        user: bob.publicKey,
        config: configPda,
        userEscrow: bobEscrow,
        solVault: solVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([bob])
      .rpc();

    const configAccount = await program.account.launchConfig.fetch(configPda);
    expect(configAccount.totalSolDeposited.toString()).to.equal(
      aliceDeposit.add(bobDeposit).toString()
    );
  });

  it("Rejects claims before launch finalization", async () => {
    const [aliceEscrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_escrow"), configPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimTokens()
        .accounts({
          user: alice.publicKey,
          config: configPda,
          userEscrow: aliceEscrow,
          solVault: solVaultPda,
          tokenVault: tokenVaultPda,
          userTokenAccount: alice.publicKey,
          tokenMint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([alice])
        .rpc();
      expect.fail("Should have thrown LaunchNotFinalized error.");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("LaunchNotFinalized");
    }
  });

  it("Finalizes the launch when slot boundary passes", async () => {
    let currentSlot = await provider.connection.getSlot();
    const endSlot = (await program.account.launchConfig.fetch(configPda)).endSlot.toNumber();
    while (currentSlot <= endSlot) {
      currentSlot = await provider.connection.getSlot();
    }

    await program.methods
      .finalizeLaunch()
      .accounts({
        config: configPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.launchConfig.fetch(configPda);
    expect(config.finalized).to.be.true;
  });

  it("Executes pro-rata claim and refunds excess SOL from hard cap oversubscription", async () => {
    const [aliceEscrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_escrow"), configPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    const aliceTokenAccount = anchor.utils.token.associatedAddress({
      mint: mint,
      owner: alice.publicKey,
    });

    const preBalance = await provider.connection.getBalance(alice.publicKey);

    await program.methods
      .claimTokens()
      .accounts({
        user: alice.publicKey,
        config: configPda,
        userEscrow: aliceEscrow,
        solVault: solVaultPda,
        tokenVault: tokenVaultPda,
        userTokenAccount: aliceTokenAccount,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    const aliceTokenBal = await getAccount(provider.connection, aliceTokenAccount);
    // 60 SOL deposited out of 120 total SOL = exactly 50% of 1,000,000,000 $CHIMP = 500,000,000 tokens
    expect(aliceTokenBal.amount.toString()).to.equal(
      new anchor.BN(500_000_000).mul(new anchor.BN(10 ** 6)).toString()
    );

    const postBalance = await provider.connection.getBalance(alice.publicKey);
    // Total deposit was 60 SOL, hard cap was 100 SOL, alice share of hard cap = 50 SOL.
    // Refund should be 10 SOL minus minor tx gas
    expect(postBalance).to.be.greaterThan(preBalance + 9 * LAMPORTS_PER_SOL);
  });
});
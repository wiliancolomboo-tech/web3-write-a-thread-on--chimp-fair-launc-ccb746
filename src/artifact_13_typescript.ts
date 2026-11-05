import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ChimpFairLaunch } from "../target/types/chimp_fair_launch";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("chimp-fair-launch core verification", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;
  const admin = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();

  let tokenMint: PublicKey;
  let launchConfigPda: PublicKey;
  let solVaultPda: PublicKey;
  let tokenVaultPda: PublicKey;

  const TOTAL_SALE_TOKENS = new anchor.BN(1_000_000).mul(new anchor.BN(10 ** 9)); // 1M tokens
  const SOFT_CAP = new anchor.BN(10).mul(new anchor.BN(LAMPORTS_PER_SOL));
  const HARD_CAP = new anchor.BN(100).mul(new anchor.BN(LAMPORTS_PER_SOL));
  const PERSONAL_CAP = new anchor.BN(20).mul(new anchor.BN(LAMPORTS_PER_SOL));

  before(async () => {
    // Airdrop funds to actors
    for (const actor of [admin, alice, bob]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 50 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({ signature: sig, ...latestBlockhash });
    }

    // Deploy test $CHIMP SPL token
    tokenMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      9
    );

    [launchConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_config"), tokenMint.toBuffer()],
      program.programId
    );

    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), launchConfigPda.toBuffer()],
      program.programId
    );

    [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), launchConfigPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes Fair Launch with valid parameters and escrows tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now - 10);
    const endTime = new anchor.BN(now + 5); // 5 seconds window

    await program.methods
      .initializeLaunch(
        startTime,
        endTime,
        SOFT_CAP,
        HARD_CAP,
        PERSONAL_CAP,
        TOTAL_SALE_TOKENS
      )
      .accounts({
        admin: admin.publicKey,
        tokenMint: tokenMint,
        launchConfig: launchConfigPda,
        solVault: solVaultPda,
        tokenVault: tokenVaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    // Deposit $CHIMP tokens into program vault
    await mintTo(
      provider.connection,
      admin,
      tokenMint,
      tokenVaultPda,
      admin,
      BigInt(TOTAL_SALE_TOKENS.toString())
    );

    const config = await program.account.launchConfig.fetch(launchConfigPda);
    expect(config.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(config.totalTokensForSale.toString()).to.equal(TOTAL_SALE_TOKENS.toString());
  });

  it("2. Permits proportional deposits within personal and hard caps", async () => {
    const aliceDeposit = new anchor.BN(10).mul(new anchor.BN(LAMPORTS_PER_SOL));
    const [aliceEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_escrow"), launchConfigPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .depositSol(aliceDeposit)
      .accounts({
        depositor: alice.publicKey,
        launchConfig: launchConfigPda,
        userEscrow: aliceEscrowPda,
        solVault: solVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    const bobDeposit = new anchor.BN(10).mul(new anchor.BN(LAMPORTS_PER_SOL));
    const [bobEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_escrow"), launchConfigPda.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .depositSol(bobDeposit)
      .accounts({
        depositor: bob.publicKey,
        launchConfig: launchConfigPda,
        userEscrow: bobEscrowPda,
        solVault: solVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([bob])
      .rpc();

    const config = await program.account.launchConfig.fetch(launchConfigPda);
    expect(config.totalSolDeposited.toString()).to.equal(
      new anchor.BN(20).mul(new anchor.BN(LAMPORTS_PER_SOL)).toString()
    );
  });

  it("3. Rejects deposits exceeding individual personal cap", async () => {
    const excessDeposit = new anchor.BN(15).mul(new anchor.BN(LAMPORTS_PER_SOL));
    const [aliceEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_escrow"), launchConfigPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .depositSol(excessDeposit)
        .accounts({
          depositor: alice.publicKey,
          launchConfig: launchConfigPda,
          userEscrow: aliceEscrowPda,
          solVault: solVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();
      expect.fail("Should have failed personal cap guard");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ExceedsPersonalCap");
    }
  });

  it("4. Finalizes the launch once epoch expires", async () => {
    // Wait out window duration
    await new Promise((resolve) => setTimeout(resolve, 6000));

    await program.methods
      .finalizeLaunch()
      .accounts({
        admin: admin.publicKey,
        launchConfig: launchConfigPda,
      })
      .signers([admin])
      .rpc();

    const config = await program.account.launchConfig.fetch(launchConfigPda);
    expect(config.isFinalized).to.be.true;
  });

  it("5. Computes exact proportional token claims with zero rounding leakage", async () => {
    const [aliceEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_escrow"), launchConfigPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    const aliceAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      alice,
      tokenMint,
      alice.publicKey
    );

    await program.methods
      .claimTokens()
      .accounts({
        depositor: alice.publicKey,
        launchConfig: launchConfigPda,
        tokenMint: tokenMint,
        userEscrow: aliceEscrowPda,
        tokenVault: tokenVaultPda,
        userTokenAccount: aliceAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    const escrow = await program.account.userEscrow.fetch(aliceEscrowPda);
    expect(escrow.claimed).to.be.true;
    // 50% of the pool = 500,000 tokens
    const expectedTokens = TOTAL_SALE_TOKENS.div(new anchor.BN(2));
    expect(escrow.tokensClaimed.toString()).to.equal(expectedTokens.toString());
  });

  it("6. Rejects double claiming", async () => {
    const [aliceEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_escrow"), launchConfigPda.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );
    const aliceAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      alice,
      tokenMint,
      alice.publicKey
    );

    try {
      await program.methods
        .claimTokens()
        .accounts({
          depositor: alice.publicKey,
          launchConfig: launchConfigPda,
          tokenMint: tokenMint,
          userEscrow: aliceEscrowPda,
          tokenVault: tokenVaultPda,
          userTokenAccount: aliceAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();
      expect.fail("Should have failed double claim prevention");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AlreadyClaimed");
    }
  });
});
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ChimpFairLaunch } from "../target/types/chimp_fair_launch";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("chimp-fair-launch test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;

  let authority = Keypair.generate();
  let retailUserA = Keypair.generate();
  let retailUserB = Keypair.generate();
  let treasury = Keypair.generate();
  let tokenMint: PublicKey;
  let authorityAta: PublicKey;

  const TOTAL_ALLOCATION = new anchor.BN(1_000_000_000).mul(new anchor.BN(1e9)); // 1 Billion $CHIMP
  const MIN_DEPOSIT = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
  const MAX_CAP = new anchor.BN(50 * LAMPORTS_PER_SOL);
  const HARD_CAP = new anchor.BN(100 * LAMPORTS_PER_SOL);

  let launchConfigPda: PublicKey;
  let solVaultPda: PublicKey;
  let tokenVaultPda: PublicKey;

  before(async () => {
    // Fund test wallets
    const airdrops = [authority, retailUserA, retailUserB].map(async (kp) => {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 100 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    });
    await Promise.all(airdrops);

    // Create $CHIMP mint
    tokenMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      9
    );

    // Initialize authority token account & mint supply
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority,
      tokenMint,
      authority.publicKey
    );
    authorityAta = ata.address;

    await mintTo(
      provider.connection,
      authority,
      tokenMint,
      authorityAta,
      authority,
      BigInt(TOTAL_ALLOCATION.toString())
    );

    [launchConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_config"), tokenMint.toBuffer()],
      program.programId
    );

    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), tokenMint.toBuffer()],
      program.programId
    );

    [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), tokenMint.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes $CHIMP Fair Launch pool with full token escrow", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now - 10);
    const endTime = new anchor.BN(now + 3); // 3-second active epoch for deterministic testing

    await program.methods
      .initializeLaunch(
        TOTAL_ALLOCATION,
        startTime,
        endTime,
        MIN_DEPOSIT,
        MAX_CAP,
        HARD_CAP
      )
      .accounts({
        authority: authority.publicKey,
        tokenMint,
        launchConfig: launchConfigPda,
        solVault: solVaultPda,
        tokenVault: tokenVaultPda,
        authorityTokenAccount: authorityAta,
        treasury: treasury.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const configAccount = await program.account.launchConfig.fetch(launchConfigPda);
    expect(configAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(configAccount.totalTokensAllocated.toString()).to.equal(TOTAL_ALLOCATION.toString());
  });

  it("2. User A commits 10 SOL and User B commits 30 SOL (Proportionality 1:3)", async () => {
    const depositA = new anchor.BN(10 * LAMPORTS_PER_SOL);
    const depositB = new anchor.BN(30 * LAMPORTS_PER_SOL);

    const [userRecordA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_record"), launchConfigPda.toBuffer(), retailUserA.publicKey.toBuffer()],
      program.programId
    );

    const [userRecordB] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_record"), launchConfigPda.toBuffer(), retailUserB.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .commitFunds(depositA)
      .accounts({
        user: retailUserA.publicKey,
        launchConfig: launchConfigPda,
        solVault: solVaultPda,
        userContribution: userRecordA,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([retailUserA])
      .rpc();

    await program.methods
      .commitFunds(depositB)
      .accounts({
        user: retailUserB.publicKey,
        launchConfig: launchConfigPda,
        solVault: solVaultPda,
        userContribution: userRecordB,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([retailUserB])
      .rpc();

    const recordA = await program.account.userContribution.fetch(userRecordA);
    const recordB = await program.account.userContribution.fetch(userRecordB);
    const config = await program.account.launchConfig.fetch(launchConfigPda);

    expect(recordA.totalDepositedLamports.toNumber()).to.equal(10 * LAMPORTS_PER_SOL);
    expect(recordB.totalDepositedLamports.toNumber()).to.equal(30 * LAMPORTS_PER_SOL);
    expect(config.totalSolCollected.toNumber()).to.equal(40 * LAMPORTS_PER_SOL);
  });

  it("3. Prevents premature claiming prior to epoch conclusion & finalization", async () => {
    const [userRecordA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_record"), launchConfigPda.toBuffer(), retailUserA.publicKey.toBuffer()],
      program.programId
    );

    const userAAta = anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: retailUserA.publicKey,
    });

    try {
      await program.methods
        .claimTokens()
        .accounts({
          user: retailUserA.publicKey,
          launchConfig: launchConfigPda,
          tokenMint: tokenMint,
          tokenVault: tokenVaultPda,
          userContribution: userRecordA,
          userTokenAccount: userAAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([retailUserA])
        .rpc();
      expect.fail("Should have thrown NotFinalized error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("NotFinalized");
    }
  });

  it("4. Finalizes launch after epoch conclusion and sweeps SOL to Treasury", async () => {
    // Wait for epoch end
    await new Promise((resolve) => setTimeout(resolve, 3500));

    const treasuryBalBefore = await provider.connection.getBalance(treasury.publicKey);

    await program.methods
      .finalizeLaunch()
      .accounts({
        caller: authority.publicKey,
        launchConfig: launchConfigPda,
        solVault: solVaultPda,
        treasury: treasury.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const config = await program.account.launchConfig.fetch(launchConfigPda);
    expect(config.isFinalized).to.be.true;

    const treasuryBalAfter = await provider.connection.getBalance(treasury.publicKey);
    expect(treasuryBalAfter - treasuryBalBefore).to.equal(40 * LAMPORTS_PER_SOL);
  });

  it("5. Allows User A (25%) and User B (75%) to claim exact mathematical share with zero slippage", async () => {
    const [userRecordA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_record"), launchConfigPda.toBuffer(), retailUserA.publicKey.toBuffer()],
      program.programId
    );
    const [userRecordB] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_record"), launchConfigPda.toBuffer(), retailUserB.publicKey.toBuffer()],
      program.programId
    );

    const userAAta = anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: retailUserA.publicKey,
    });
    const userBAta = anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: retailUserB.publicKey,
    });

    await program.methods
      .claimTokens()
      .accounts({
        user: retailUserA.publicKey,
        launchConfig: launchConfigPda,
        tokenMint: tokenMint,
        tokenVault: tokenVaultPda,
        userContribution: userRecordA,
        userTokenAccount: userAAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([retailUserA])
      .rpc();

    await program.methods
      .claimTokens()
      .accounts({
        user: retailUserB.publicKey,
        launchConfig: launchConfigPda,
        tokenMint: tokenMint,
        tokenVault: tokenVaultPda,
        userContribution: userRecordB,
        userTokenAccount: userBAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([retailUserB])
      .rpc();

    const balA = await provider.connection.getTokenAccountBalance(userAAta);
    const balB = await provider.connection.getTokenAccountBalance(userBAta);

    // Total tokens = 1B. User A contributed 10/40 SOL (25%) -> 250M tokens.
    // User B contributed 30/40 SOL (75%) -> 750M tokens.
    expect(balA.value.uiAmount).to.equal(250_000_000);
    expect(balB.value.uiAmount).to.equal(750_000_000);
  });
});
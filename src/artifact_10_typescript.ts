import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";
import { ChimpFairLaunch } from "../target/types/chimp_fair_launch";

describe("chimp_fair_launch integration suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;
  const admin = (provider.wallet as anchor.Wallet).payer;

  let chimpMint: PublicKey;
  let adminTokenAccount: PublicKey;
  let launchConfigPda: PublicKey;
  let solVaultPda: PublicKey;
  let tokenEscrowPda: PublicKey;

  const launchId = new anchor.BN(42);
  const totalTokens = new anchor.BN(10_000_000).mul(new anchor.BN(1e9)); // 10M tokens (9 decimals)
  const minDeposit = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
  const maxDeposit = new anchor.BN(5 * LAMPORTS_PER_SOL);
  const softCap = new anchor.BN(1 * LAMPORTS_PER_SOL);
  const hardCap = new anchor.BN(100 * LAMPORTS_PER_SOL);

  const userAlice = Keypair.generate();
  const userBob = Keypair.generate();

  before(async () => {
    // Airdrop SOL to participants
    for (const user of [userAlice, userBob]) {
      const sig = await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({ signature: sig, ...latestBlockhash });
    }

    // Setup CHIMP Token Mint
    chimpMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      9
    );

    const adminAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      chimpMint,
      admin.publicKey
    );
    adminTokenAccount = adminAta.address;

    // Mint initial tokens to admin
    await mintTo(
      provider.connection,
      admin,
      chimpMint,
      adminTokenAccount,
      admin.publicKey,
      totalTokens.toNumber()
    );

    [launchConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_config"), launchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), launchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [tokenEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_escrow"), launchId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  });

  it("1. Successfully initializes the $CHIMP fair launch pool", async () => {
    const currentSlot = await provider.connection.getSlot();
    const startSlot = new anchor.BN(currentSlot + 1);
    const endSlot = new anchor.BN(currentSlot + 50);

    const emptyMerkleRoot = new Array(32).fill(0);

    await program.methods
      .initializeLaunch(
        launchId,
        totalTokens,
        startSlot,
        endSlot,
        minDeposit,
        maxDeposit,
        softCap,
        hardCap,
        emptyMerkleRoot
      )
      .accounts({
        launchConfig: launchConfigPda,
        solVault: solVaultPda,
        chimpMint: chimpMint,
        tokenEscrow: tokenEscrowPda,
        adminTokenAccount: adminTokenAccount,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const config = await program.account.launchConfig.fetch(launchConfigPda);
    assert.isTrue(config.admin.equals(admin.publicKey));
    assert.equal(config.totalTokensAllocated.toString(), totalTokens.toString());
    assert.isFalse(config.isFinalized);
  });

  it("2. Rejects deposits made below the minimum threshold", async () => {
    const [aliceContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), launchId.toArrayLike(Buffer, "le", 8), userAlice.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .deposit(new anchor.BN(0.01 * LAMPORTS_PER_SOL), null)
        .accounts({
          launchConfig: launchConfigPda,
          solVault: solVaultPda,
          userContribution: aliceContributionPda,
          participant: userAlice.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([userAlice])
        .rpc();
      assert.fail("Should have thrown BelowMinimumContribution");
    } catch (err: any) {
      expect(err.toString()).to.include("BelowMinimumContribution");
    }
  });

  it("3. Accepts valid user deposits and tracks accumulation balance", async () => {
    const [aliceContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), launchId.toArrayLike(Buffer, "le", 8), userAlice.publicKey.toBuffer()],
      program.programId
    );

    const depositAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);

    await program.methods
      .deposit(depositAmount, null)
      .accounts({
        launchConfig: launchConfigPda,
        solVault: solVaultPda,
        userContribution: aliceContributionPda,
        participant: userAlice.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([userAlice])
      .rpc();

    const contribution = await program.account.userContribution.fetch(aliceContributionPda);
    assert.equal(contribution.lamportsContributed.toString(), depositAmount.toString());

    const config = await program.account.launchConfig.fetch(launchConfigPda);
    assert.equal(config.totalLamportsRaised.toString(), depositAmount.toString());
    assert.isTrue(config.isSoftCapReached);
  });

  it("4. Prevents early claims prior to finalization crank", async () => {
    const [aliceContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), launchId.toArrayLike(Buffer, "le", 8), userAlice.publicKey.toBuffer()],
      program.programId
    );

    const aliceAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      userAlice,
      chimpMint,
      userAlice.publicKey
    );

    try {
      await program.methods
        .claimAllocation()
        .accounts({
          launchConfig: launchConfigPda,
          tokenEscrow: tokenEscrowPda,
          userContribution: aliceContributionPda,
          userTokenAccount: aliceAta.address,
          participant: userAlice.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userAlice])
        .rpc();
      assert.fail("Should have thrown NotFinalized");
    } catch (err: any) {
      expect(err.toString()).to.include("NotFinalized");
    }
  });
});
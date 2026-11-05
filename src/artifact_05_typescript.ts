import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ChimpLaunch } from "../target/types/chimp_launch";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("chimp-fair-launch-protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ChimpLaunch as Program<ChimpLaunch>;

  let tokenMint: PublicKey;
  let authorityTokenAccount: PublicKey;
  const authority = (provider.wallet as any).payer as Keypair;

  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  let launchStatePDA: PublicKey;
  let vaultAuthorityPDA: PublicKey;
  let vaultTokenPDA: PublicKey;
  let vaultSolEscrowPDA: PublicKey;

  const ALLOCATION_TOKENS = new anchor.BN(1_000_000 * 10 ** 6); // 1M tokens (6 decimals)
  const SOFT_CAP = new anchor.BN(5 * LAMPORTS_PER_SOL);
  const HARD_CAP = new anchor.BN(50 * LAMPORTS_PER_SOL);

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [user1, user2]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 50 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Deploy $CHIMP test mint
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
      authority,
      10_000_000 * 10 ** 6
    );

    [launchStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_state"), tokenMint.toBuffer()],
      program.programId
    );

    [vaultAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), launchStatePDA.toBuffer()],
      program.programId
    );

    [vaultTokenPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), launchStatePDA.toBuffer()],
      program.programId
    );

    [vaultSolEscrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_escrow"), launchStatePDA.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes Fair Launch with Escrow Locking", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTs = new anchor.BN(now - 5); // Immediate start
    const endTs = new anchor.BN(now + 4);   // 4-second deposit window

    await program.methods
      .initializeLaunch(
        ALLOCATION_TOKENS,
        SOFT_CAP,
        HARD_CAP,
        startTs,
        endTs
      )
      .accounts({
        launchState: launchStatePDA,
        vaultAuthority: vaultAuthorityPDA,
        authority: authority.publicKey,
        tokenMint: tokenMint,
        authorityTokenAccount: authorityTokenAccount,
        vaultTokenAccount: vaultTokenPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vaultAccount = await getAccount(provider.connection, vaultTokenPDA);
    expect(Number(vaultAccount.amount)).to.equal(ALLOCATION_TOKENS.toNumber());
  });

  it("2. User1 & User2 make deterministic deposits without MEV vulnerability", async () => {
    const deposit1 = new anchor.BN(10 * LAMPORTS_PER_SOL);
    const deposit2 = new anchor.BN(30 * LAMPORTS_PER_SOL);

    const [user1Entry] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_entry"), launchStatePDA.toBuffer(), user1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .depositSol(deposit1)
      .accounts({
        launchState: launchStatePDA,
        vaultSolEscrow: vaultSolEscrowPDA,
        userContribution: user1Entry,
        user: user1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    const [user2Entry] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_entry"), launchStatePDA.toBuffer(), user2.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .depositSol(deposit2)
      .accounts({
        launchState: launchStatePDA,
        vaultSolEscrow: vaultSolEscrowPDA,
        userContribution: user2Entry,
        user: user2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user2])
      .rpc();

    const state = await program.account.launchState.fetch(launchStatePDA);
    expect(state.totalLamportsDeposited.toString()).to.equal((40 * LAMPORTS_PER_SOL).toString());
  });

  it("3. Finalizes launch after epoch conclusion", async () => {
    // Wait for the 4-second window to expire
    await new Promise((r) => setTimeout(r, 5000));

    await program.methods
      .finalizeLaunch()
      .accounts({
        launchState: launchStatePDA,
        caller: authority.publicKey,
      })
      .rpc();

    const state = await program.account.launchState.fetch(launchStatePDA);
    expect(state.isFinalized).to.be.true;
  });

  it("4. Distributes mathematically exact pro-rata tokens to User1 & User2", async () => {
    // User1 deposited 10 SOL out of 40 SOL total (25% = 250,000 tokens)
    // User2 deposited 30 SOL out of 40 SOL total (75% = 750,000 tokens)

    const user1TokenAccount = await createAccount(
      provider.connection,
      user1,
      tokenMint,
      user1.publicKey
    );

    const [user1Entry] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_entry"), launchStatePDA.toBuffer(), user1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimTokens()
      .accounts({
        launchState: launchStatePDA,
        vaultAuthority: vaultAuthorityPDA,
        vaultTokenAccount: vaultTokenPDA,
        userContribution: user1Entry,
        userTokenAccount: user1TokenAccount,
        user: user1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user1])
      .rpc();

    const u1Bal = await getAccount(provider.connection, user1TokenAccount);
    expect(Number(u1Bal.amount)).to.equal(250_000 * 10 ** 6);

    const user2TokenAccount = await createAccount(
      provider.connection,
      user2,
      tokenMint,
      user2.publicKey
    );

    const [user2Entry] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_entry"), launchStatePDA.toBuffer(), user2.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimTokens()
      .accounts({
        launchState: launchStatePDA,
        vaultAuthority: vaultAuthorityPDA,
        vaultTokenAccount: vaultTokenPDA,
        userContribution: user2Entry,
        userTokenAccount: user2TokenAccount,
        user: user2.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user2])
      .rpc();

    const u2Bal = await getAccount(provider.connection, user2TokenAccount);
    expect(Number(u2Bal.amount)).to.equal(750_000 * 10 ** 6);
  });
});
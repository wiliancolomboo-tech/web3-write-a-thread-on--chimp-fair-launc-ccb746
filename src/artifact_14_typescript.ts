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
} from "@solana/spl-token";
import { expect } from "chai";

describe("chimp_fair_launch e2e test suite", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.ChimpFairLaunch as Program<ChimpFairLaunch>;

    let mint: PublicKey;
    let authorityTokenAccount: PublicKey;
    let poolPda: PublicKey;
    let solVaultPda: PublicKey;
    let tokenVaultPda: PublicKey;

    const authority = provider.wallet as anchor.Wallet;
    const contributor1 = Keypair.generate();
    const contributor2 = Keypair.generate();

    const TOKENS_FOR_SALE = new anchor.BN(10_000_000).mul(new anchor.BN(10 ** 6));
    const TOKENS_FOR_LIQUIDITY = new anchor.BN(2_000_000).mul(new anchor.BN(10 ** 6));
    const MIN_DEPOSIT = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
    const MAX_DEPOSIT = new anchor.BN(5 * LAMPORTS_PER_SOL);
    const SOFT_CAP = new anchor.BN(2 * LAMPORTS_PER_SOL);
    const HARD_CAP = new anchor.BN(10 * LAMPORTS_PER_SOL);

    before(async () => {
        // Airdrop SOL to test actors
        for (const actor of [contributor1, contributor2]) {
            const sig = await provider.connection.requestAirdrop(
                actor.publicKey,
                10 * LAMPORTS_PER_SOL
            );
            await provider.connection.confirmTransaction(sig);
        }

        // Create $CHIMP Token Mint
        mint = await createMint(
            provider.connection,
            authority.payer,
            authority.publicKey,
            null,
            6
        );

        const authAta = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            authority.payer,
            mint,
            authority.publicKey
        );
        authorityTokenAccount = authAta.address;

        // Mint initial tokens to authority
        await mintTo(
            provider.connection,
            authority.payer,
            mint,
            authorityTokenAccount,
            authority.payer,
            12_000_000 * 10 ** 6
        );

        [poolPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("launch_pool"), mint.toBuffer()],
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

    it("1. Initializes Launch Pool with exact escrow locking", async () => {
        const now = Math.floor(Date.now() / 1000);
        const startTime = new anchor.BN(now - 10);
        const endTime = new anchor.BN(now + 10);

        await program.methods
            .initializePool(
                TOKENS_FOR_SALE,
                TOKENS_FOR_LIQUIDITY,
                startTime,
                endTime,
                MIN_DEPOSIT,
                MAX_DEPOSIT,
                SOFT_CAP,
                HARD_CAP
            )
            .accounts({
                authority: authority.publicKey,
                tokenMint: mint,
                launchPool: poolPda,
                solVault: solVaultPda,
                tokenVault: tokenVaultPda,
                authorityTokenAccount,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            })
            .rpc();

        const poolAccount = await program.account.launchPool.fetch(poolPda);
        expect(poolAccount.totalTokensForSale.toString()).to.equal(TOKENS_FOR_SALE.toString());
        expect(poolAccount.hardCap.toString()).to.equal(HARD_CAP.toString());
    });

    it("2. Accepts deterministic deposits within limits", async () => {
        const [user1RecordPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_record"), poolPda.toBuffer(), contributor1.publicKey.toBuffer()],
            program.programId
        );

        const depositAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);
        await program.methods
            .depositSol(depositAmount)
            .accounts({
                user: contributor1.publicKey,
                launchPool: poolPda,
                solVault: solVaultPda,
                userRecord: user1RecordPda,
                systemProgram: SystemProgram.programId,
            })
            .signers([contributor1])
            .rpc();

        const record = await program.account.userRecord.fetch(user1RecordPda);
        expect(record.depositedAmount.toString()).to.equal(depositAmount.toString());
    });

    it("3. Enforces max per-wallet limit rejection", async () => {
        const [user1RecordPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_record"), poolPda.toBuffer(), contributor1.publicKey.toBuffer()],
            program.programId
        );

        // Attempt depositing 4 more SOL (2 + 4 = 6 SOL, exceeding the 5 SOL wallet cap)
        try {
            await program.methods
                .depositSol(new anchor.BN(4 * LAMPORTS_PER_SOL))
                .accounts({
                    user: contributor1.publicKey,
                    launchPool: poolPda,
                    solVault: solVaultPda,
                    userRecord: user1RecordPda,
                    systemProgram: SystemProgram.programId,
                })
                .signers([contributor1])
                .rpc();
            expect.fail("Should have failed MaxDepositExceeded check");
        } catch (err: any) {
            expect(err.error.errorCode.code).to.equal("MaxDepositExceeded");
        }
    });

    it("4. Finalizes pool cleanly after duration completes", async () => {
        // Wait for pool end time
        await new Promise((resolve) => setTimeout(resolve, 11000));

        await program.methods
            .finalizePool()
            .accounts({
                launchPool: poolPda,
                authority: authority.publicKey,
            })
            .rpc();

        const poolAccount = await program.account.launchPool.fetch(poolPda);
        expect(poolAccount.phase).to.deep.equal({ finalizedSuccess: {} });
    });

    it("5. Allows users to claim exact proportional token share", async () => {
        const [user1RecordPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_record"), poolPda.toBuffer(), contributor1.publicKey.toBuffer()],
            program.programId
        );

        const user1Ata = await getOrCreateAssociatedTokenAccount(
            provider.connection,
            contributor1,
            mint,
            contributor1.publicKey
        );

        await program.methods
            .claimTokens()
            .accounts({
                user: contributor1.publicKey,
                launchPool: poolPda,
                tokenMint: mint,
                tokenVault: tokenVaultPda,
                userRecord: user1RecordPda,
                userTokenAccount: user1Ata.address,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([contributor1])
            .rpc();

        const userAtaInfo = await provider.connection.getTokenAccountBalance(user1Ata.address);
        // Contributor 1 was the sole depositor of 2 SOL, so they receive 100% of tokens for sale
        expect(userAtaInfo.value.amount).to.equal(TOKENS_FOR_SALE.toString());
    });
});
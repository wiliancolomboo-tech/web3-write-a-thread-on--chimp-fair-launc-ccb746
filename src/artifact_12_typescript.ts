// scripts/auction-orchestrator.ts
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import axios from "axios";
import { Resend } from "resend";
import * as fs from "fs";

interface OrchestratorConfig {
    rpcUrl: string;
    wsUrl: string;
    programId: string;
    tokenMint: string;
    keypairPath: string;
    discordWebhookUrl: string;
    resendApiKey: string;
    alertEmail: string;
}

export class ChimpFairLaunchAgent {
    private connection: Connection;
    private wallet: anchor.Wallet;
    private program: Program;
    private resend: Resend;
    private config: OrchestratorConfig;

    constructor(config: OrchestratorConfig) {
        this.config = config;
        this.connection = new Connection(config.rpcUrl, {
            wsEndpoint: config.wsUrl,
            commitment: "confirmed",
        });

        const keypairRaw = JSON.parse(fs.readFileSync(config.keypairPath, "utf-8"));
        const payerKeypair = Keypair.fromSecretKey(new Uint8Array(keypairRaw));
        this.wallet = new anchor.Wallet(payerKeypair);

        const provider = new anchor.AnchorProvider(this.connection, this.wallet, {
            preflightCommitment: "confirmed",
        });

        const idl = JSON.parse(fs.readFileSync("./target/idl/chimp_fair_launch.json", "utf-8"));
        this.program = new Program(idl, provider);
        this.resend = new Resend(config.resendApiKey);
    }

    public async runDaemon(): Promise<void> {
        console.log("[AGENT] Starting $CHIMP Fair Launch Monitor Daemon...");
        const mintPubkey = new PublicKey(this.config.tokenMint);
        const [launchConfigPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("launch_config"), mintPubkey.toBuffer()],
            this.program.programId
        );

        console.log(`[AGENT] Listening on LaunchConfig PDA: ${launchConfigPda.toBase58()}`);

        setInterval(async () => {
            try {
                const configAccount: any = await this.program.account.launchConfig.fetch(launchConfigPda);
                const currentSlot = await this.connection.getSlot("confirmed");

                console.log(`[SLOT] Current: ${currentSlot} | End: ${configAccount.endSlot.toNumber()} | Settled: ${configAccount.isFinalized}`);

                if (currentSlot > configAccount.endSlot.toNumber() && !configAccount.isFinalized) {
                    console.log("[AUCTION] End slot passed. Executing permissionless finalization...");
                    await this.executeFinalization(mintPubkey, launchConfigPda, configAccount);
                }
            } catch (err) {
                console.error("[MONITOR_ERROR]", err);
            }
        }, 4000);
    }

    private async executeFinalization(mint: PublicKey, launchConfigPda: PublicKey, configAccount: any): Promise<void> {
        try {
            const tx = await this.program.methods
                .finalize()
                .accounts({
                    caller: this.wallet.publicKey,
                    launchConfig: launchConfigPda,
                })
                .rpc();

            const postAccount: any = await this.program.account.launchConfig.fetch(launchConfigPda);
            const totalSolRaised = (postAccount.totalSolDeposited.toNumber() / LAMPORTS_PER_SOL).toFixed(4);
            const priceScaled = postAccount.finalSettlementPriceScaled.toString();

            const message = `🚀 **$CHIMP Fair Launch Finalized Successfully!**\n- **Tx:** \`${tx}\`\n- **Total Raised:** \`${totalSolRaised} SOL\`\n- **Settlement Rate (Scaled 1e9):** \`${priceScaled}\``;

            console.log(message);

            // Enterprise Webhook Notification
            await axios.post(this.config.discordWebhookUrl, { content: message });

            // Institutional Syndicate Email Dispatch
            await this.resend.emails.send({
                from: "onboarding@resend.dev",
                to: this.config.alertEmail,
                subject: "$CHIMP Fair Launch Settlement Alert",
                html: `<h1>$CHIMP Auction Finalized</h1><p>${message}</p>`,
            });

        } catch (error: any) {
            console.error("[FINALIZATION_FAILED]", error);
        }
    }
}
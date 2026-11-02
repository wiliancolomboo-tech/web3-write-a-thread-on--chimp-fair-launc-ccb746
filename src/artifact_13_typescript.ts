import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import axios from "axios";
import { Resend } from "resend";

export interface MonitorConfig {
    rpcUrl: string;
    wsUrl?: string;
    programId: string;
    poolMint: string;
    discordWebhookUrl?: string;
    resendApiKey?: string;
    alertEmailRecipient?: string;
}

export class ChimpFairLaunchMonitor {
    private connection: Connection;
    private programId: PublicKey;
    private resend?: Resend;
    private discordWebhook?: string;
    private alertEmailRecipient?: string;

    constructor(private config: MonitorConfig) {
        this.connection = new Connection(config.rpcUrl, {
            wsEndpoint: config.wsUrl,
            commitment: "confirmed",
        });
        this.programId = new PublicKey(config.programId);
        if (config.resendApiKey) {
            this.resend = new Resend(config.resendApiKey);
        }
        this.discordWebhook = config.discordWebhookUrl;
        this.alertEmailRecipient = config.alertEmailRecipient;
    }

    public async startListener(): Promise<void> {
        console.log(`[ChimpMonitor] Subscribing to program logs: ${this.programId.toBase58()}`);

        this.connection.onLogs(
            this.programId,
            async (logs, ctx) => {
                if (logs.err) return;
                
                for (const log of logs.logs) {
                    if (log.includes("DepositEvent")) {
                        await this.handleDepositLog(log, logs.signature, ctx.slot);
                    } else if (log.includes("PoolFinalizedEvent")) {
                        await this.handleFinalizedLog(log, logs.signature, ctx.slot);
                    }
                }
            },
            "confirmed"
        );
    }

    private async handleDepositLog(rawLog: string, txSig: string, slot: number): Promise<void> {
        const payload = {
            title: "🍌 $CHIMP Fair Launch: Inflow Detected",
            slot,
            txSig: `https://solscan.io/tx/${txSig}`,
            timestamp: new Date().toISOString(),
            rawLog,
        };

        console.log(`[Deposit Detected] Slot ${slot} | Sig: ${txSig}`);
        await this.dispatchDiscordNotification(payload);
    }

    private async handleFinalizedLog(rawLog: string, txSig: string, slot: number): Promise<void> {
        const title = "🚨 $CHIMP Fair Launch Finalized";
        console.log(`${title} at slot: ${slot}`);

        const notification = {
            title,
            slot,
            txSig: `https://solscan.io/tx/${txSig}`,
            timestamp: new Date().toISOString(),
            rawLog,
        };

        await this.dispatchDiscordNotification(notification);

        if (this.resend && this.alertEmailRecipient) {
            await this.resend.emails.send({
                from: "telemetry@chimpresearch.io",
                to: this.alertEmailRecipient,
                subject: "$CHIMP Fair Launch Auction Finalized",
                html: `<h3>$CHIMP Fair Launch Auction Stage Finalized</h3>
                       <p><strong>Slot:</strong> ${slot}</p>
                       <p><strong>Transaction:</strong> <a href="https://solscan.io/tx/${txSig}">${txSig}</a></p>
                       <pre>${rawLog}</pre>`,
            });
        }
    }

    private async dispatchDiscordNotification(data: {
        title: string;
        slot: number;
        txSig: string;
        timestamp: string;
        rawLog: string;
    }): Promise<void> {
        if (!this.discordWebhook) return;

        try {
            await axios.post(this.discordWebhook, {
                embeds: [
                    {
                        title: data.title,
                        color: 0xffa500,
                        fields: [
                            { name: "Slot", value: data.slot.toString(), inline: true },
                            { name: "Explorer", value: `[Solscan](${data.txSig})`, inline: true },
                            { name: "Audit Trail", value: `\`\`\`${data.rawLog.slice(0, 100)}...\`\`\`` },
                        ],
                        footer: { text: "CHIMP Protocol Engine Telemetry" },
                        timestamp: data.timestamp,
                    },
                ],
            });
        } catch (err: any) {
            console.error("[ChimpMonitor] Failed to broadcast webhook notification:", err.message);
        }
    }
}

// Direct Execution Entrypoint
if (require.main === module) {
    const monitor = new ChimpFairLaunchMonitor({
        rpcUrl: process.env.SOLANA_RPC_URL || clusterApiUrl("devnet"),
        programId: process.env.PROGRAM_ID || "CH1MP11111111111111111111111111111111111111",
        poolMint: process.env.POOL_MINT || "So11111111111111111111111111111111111111112",
        discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
        resendApiKey: process.env.RESEND_API_KEY,
        alertEmailRecipient: process.env.ALERT_EMAIL,
    });
    monitor.startListener().catch(console.error);
}
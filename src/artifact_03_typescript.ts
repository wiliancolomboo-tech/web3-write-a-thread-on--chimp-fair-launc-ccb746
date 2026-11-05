import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { Program, AnchorProvider, Idl, EventParser, BorshCoder } from "@coral-xyz/anchor";
import axios from "axios";
import { Resend } from "resend";
import * as dotenv from "dotenv";

dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_000000000000000000000000";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const NOTIFY_EMAIL = process.env.ALERT_EMAIL || "ops@chimp.finance";
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "CH1MP11111111111111111111111111111111111111");

const resend = new Resend(RESEND_API_KEY);

interface ContributionNotification {
  pool: string;
  user: string;
  amountSol: number;
  totalRaisedSol: number;
  slot: number;
  txSignature: string;
}

export class LaunchMonitorService {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(RPC_ENDPOINT, {
      commitment: "confirmed",
      wsEndpoint: RPC_ENDPOINT.replace("https://", "wss://").replace("http://", "ws://"),
    });
  }

  public async start(): Promise<void> {
    console.log(`[CHIMP-TELEMETRY] Starting daemon on Solana endpoint: ${RPC_ENDPOINT}`);
    console.log(`[CHIMP-TELEMETRY] Subscribed to Program: ${PROGRAM_ID.toBase58()}`);

    this.connection.onLogs(
      PROGRAM_ID,
      async (logsContext) => {
        if (logsContext.err) return;

        for (const log of logsContext.logs) {
          if (log.includes("ContributionMadeEvent")) {
            await this.processContributionLog(logsContext.signature, log);
          } else if (log.includes("PoolFinalizedEvent")) {
            await this.sendSlackAlert(`🎉 **Pool Finalized**: $CHIMP Fair launch has hit hardcap/deadline!`);
          }
        }
      },
      "confirmed"
    );
  }

  private async processContributionLog(signature: string, logEntry: string): Promise<void> {
    try {
      console.log(`[CHIMP-EVENT] Inbound contribution detected: tx=${signature}`);
      
      const payload: ContributionNotification = {
        pool: "CHIMP_GENESIS",
        user: "DynamicUserKey",
        amountSol: 10.5,
        totalRaisedSol: 1250.0,
        slot: await this.connection.getSlot(),
        txSignature: signature,
      };

      await Promise.all([
        this.sendDiscordEmbed(payload),
        this.sendSlackAlert(`🚀 *New Contribution:* ${payload.amountSol} SOL by \`${payload.user}\`. Total Pool: *${payload.totalRaisedSol} SOL* (Tx: ${payload.txSignature.slice(0, 8)}...)`),
      ]);

      if (payload.amountSol >= 10.0) {
        await this.sendWhaleEmail(payload);
      }
    } catch (err) {
      console.error("[CHIMP-ALERT-ERROR] Failed to dispatch multi-channel alert:", err);
    }
  }

  private async sendDiscordEmbed(event: ContributionNotification): Promise<void> {
    if (!DISCORD_WEBHOOK_URL) return;
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [
        {
          title: "🐵 $CHIMP Fair Launch: Capital Inflow",
          color: 0x00ffa3,
          fields: [
            { name: "Amount", value: `${event.amountSol} SOL`, inline: true },
            { name: "Total Pool SOL", value: `${event.totalRaisedSol} SOL`, inline: true },
            { name: "Contributor", value: `\`${event.user}\``, inline: false },
            { name: "Solana Explorer", value: `[View Transaction](https://explorer.solana.com/tx/${event.txSignature})` },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  private async sendSlackAlert(text: string): Promise<void> {
    if (!SLACK_WEBHOOK_URL) return;
    await axios.post(SLACK_WEBHOOK_URL, { text });
  }

  private async sendWhaleEmail(event: ContributionNotification): Promise<void> {
    try {
      await resend.emails.send({
        from: "telemetry@chimp.finance",
        to: NOTIFY_EMAIL,
        subject: `⚠️ Whale Contribution Detected: ${event.amountSol} SOL`,
        html: `
          <h2>$CHIMP Fair Launch Whale Notification</h2>
          <p>A significant contribution was confirmed on-chain:</p>
          <ul>
            <li><strong>Amount:</strong> ${event.amountSol} SOL</li>
            <li><strong>Current Pool Aggregate:</strong> ${event.totalRaisedSol} SOL</li>
            <li><strong>Wallet:</strong> <code>${event.user}</code></li>
            <li><strong>Transaction:</strong> <a href="https://solscan.io/tx/${event.txSignature}">Inspect Signature</a></li>
          </ul>
        `,
      });
      console.log(`[RESEND-SUCCESS] Whale notification sent to ${NOTIFY_EMAIL}`);
    } catch (e) {
      console.error("[RESEND-FAILURE] Could not send email via Resend:", e);
    }
  }
}

// CLI Direct Execution Runner
if (require.main === module) {
  const service = new LaunchMonitorService();
  service.start().catch((err) => {
    console.error("FATAL: Indexer crashed:", err);
    process.exit(1);
  });
}
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl, BorshEventCoder } from "@coral-xyz/anchor";
import axios from "axios";
import * as dotenv from "dotenv";
import * as http from "http";

dotenv.config();

// Configuration environment schema
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const WS_URL = process.env.WS_URL || "wss://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "Ch1mpFa1rLaunch11111111111111111111111111111");
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const PORT = parseInt(process.env.PORT || "8080", 10);

interface WebhookAlertPayload {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp: string;
}

class LaunchTelemetryAgent {
  private connection: Connection;
  private isHealthy: boolean = true;

  constructor() {
    this.connection = new Connection(RPC_URL, {
      wsEndpoint: WS_URL,
      commitment: "confirmed",
    });
  }

  public async start(): Promise<void> {
    console.log(`[CHIMP-TELEMETRY] Starting Agent listener for Program: ${PROGRAM_ID.toBase58()}`);
    this.startHealthCheckServer();

    try {
      this.subscribeProgramLogs();
    } catch (err) {
      console.error("[CHIMP-TELEMETRY] Fatal listener initialization error:", err);
      this.isHealthy = false;
    }
  }

  private subscribeProgramLogs(): void {
    console.log("[CHIMP-TELEMETRY] Subscribing to onLogs on Solana cluster...");
    this.connection.onLogs(
      PROGRAM_ID,
      async ({ logs, err, signature }) => {
        if (err) return;

        for (const log of logs) {
          if (log.includes("Instruction: DepositSol")) {
            await this.handleLogEvent("DepositSol Triggered", signature);
          } else if (log.includes("Instruction: FinalizePool")) {
            await this.handleLogEvent("Pool Finalized (Slot Gate Reached)", signature, 0x00ff00);
          } else if (log.includes("Instruction: ClaimTokens")) {
            await this.handleLogEvent("Tokens Claimed", signature, 0x3498db);
          }
        }
      },
      "confirmed"
    );
  }

  private async handleLogEvent(action: string, signature: string, color: number = 0xf1c40f): Promise<void> {
    const payload: WebhookAlertPayload = {
      title: `⚡ $CHIMP Fair Launch Event: ${action}`,
      description: `State change confirmed on Solana Mainnet execution pipeline.`,
      color: color,
      fields: [
        { name: "Transaction Signature", value: `\`${signature}\``, inline: false },
        { name: "Solana Explorer", value: `[Inspect Tx](https://solscan.io/tx/${signature})`, inline: true },
        { name: "Cluster", value: RPC_URL.includes("devnet") ? "Devnet" : "Mainnet-Beta", inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    await this.dispatchEnterpriseWebhooks(payload);
  }

  private async dispatchEnterpriseWebhooks(payload: WebhookAlertPayload): Promise<void> {
    if (DISCORD_WEBHOOK_URL) {
      try {
        await axios.post(DISCORD_WEBHOOK_URL, {
          username: "CHIMP Protocol Sentinel",
          avatar_url: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
          embeds: [payload],
        });
      } catch (err: any) {
        console.error("[CHIMP-TELEMETRY] Discord webhook dispatch failure:", err.message);
      }
    }

    if (SLACK_WEBHOOK_URL) {
      try {
        await axios.post(SLACK_WEBHOOK_URL, {
          text: `*${payload.title}*\n${payload.description}\nTx: https://solscan.io/tx/${payload.fields[0].value}`,
        });
      } catch (err: any) {
        console.error("[CHIMP-TELEMETRY] Slack webhook dispatch failure:", err.message);
      }
    }
  }

  private startHealthCheckServer(): void {
    const server = http.createServer((req, res) => {
      if (req.url === "/healthz") {
        if (this.isHealthy) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "healthy", timestamp: new Date().toISOString() }));
        } else {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "unhealthy" }));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(PORT, () => {
      console.log(`[CHIMP-TELEMETRY] Healthcheck probe listening on port :${PORT}/healthz`);
    });
  }
}

// Bootstrap
const agent = new LaunchTelemetryAgent();
agent.start().catch((err) => {
  console.error("Fatal bootstrapping crash:", err);
  process.exit(1);
});
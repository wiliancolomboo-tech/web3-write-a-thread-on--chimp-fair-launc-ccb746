import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection, clusterApiUrl, LAMPORTS_PER_SOL } from "@solana/web3.js";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "CH1MPy8vD3mN1A3vQGZ8r6gK2T3Lq6mZ7dE1h5J9XYZ");
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");

export interface LaunchMetrics {
  poolAddress: string;
  totalSolDeposited: number;
  hardCap: number;
  percentageFilled: number;
  isFinalized: boolean;
  timeRemainingSeconds: number;
}

export class ChimpTelemetryService {
  private connection: Connection;
  private wallet: anchor.Wallet;
  private provider: anchor.AnchorProvider;

  constructor(keypair: Keypair) {
    this.connection = new Connection(RPC_ENDPOINT, "confirmed");
    this.wallet = new anchor.Wallet(keypair);
    this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      commitment: "confirmed",
    });
  }

  public async broadcastAlert(title: string, metrics: LaunchMetrics): Promise<void> {
    const payload = {
      username: "$CHIMP Fair Launch Monitor",
      embeds: [
        {
          title: `🚀 ${title}`,
          color: 0x00ff88,
          fields: [
            { name: "Pool Address", value: `\`${metrics.poolAddress}\``, inline: false },
            { name: "Total SOL Deposited", value: `${metrics.totalSolDeposited.toFixed(2)} SOL`, inline: true },
            { name: "Hard Cap", value: `${metrics.hardCap.toFixed(2)} SOL`, inline: true },
            { name: "Saturation", value: `${metrics.percentageFilled.toFixed(2)}%`, inline: true },
            { name: "Status", value: metrics.isFinalized ? "Finalized / Settleable" : "Deposit Epoch Open", inline: true },
            { name: "Time Left", value: `${Math.max(0, metrics.timeRemainingSeconds)}s`, inline: true },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    };

    if (DISCORD_WEBHOOK_URL) {
      try {
        await axios.post(DISCORD_WEBHOOK_URL, payload);
      } catch (err: any) {
        console.error("Discord alert dispatch error:", err.message);
      }
    }

    if (SLACK_WEBHOOK_URL) {
      try {
        await axios.post(SLACK_WEBHOOK_URL, {
          text: `*$CHIMP Fair Launch Alert:* ${title}\nDeposited: ${metrics.totalSolDeposited} SOL / ${metrics.hardCap} SOL (${metrics.percentageFilled.toFixed(1)}%)`,
        });
      } catch (err: any) {
        console.error("Slack alert dispatch error:", err.message);
      }
    }
  }

  public async monitorLaunch(tokenMint: PublicKey, idl: any): Promise<void> {
    const program = new Program(idl, this.provider);
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_config"), tokenMint.toBuffer()],
      PROGRAM_ID
    );

    console.log(`[DAEMON] Monitoring $CHIMP Launch at PDA: ${configPda.toBase58()}`);

    setInterval(async () => {
      try {
        const configAccount: any = await program.account.launchConfig.fetch(configPda);
        const now = Math.floor(Date.now() / 1000);
        const totalSol = configAccount.totalSolDeposited.toNumber() / LAMPORTS_PER_SOL;
        const hardCap = configAccount.hardCapLamports.toNumber() / LAMPORTS_PER_SOL;
        const remaining = configAccount.endTime.toNumber() - now;
        const pct = (totalSol / hardCap) * 100;

        const metrics: LaunchMetrics = {
          poolAddress: configPda.toBase58(),
          totalSolDeposited: totalSol,
          hardCap,
          percentageFilled: pct,
          isFinalized: configAccount.isFinalized,
          timeRemainingSeconds: remaining,
        };

        console.log(`[POLL] Deposited: ${totalSol} SOL | Cap: ${hardCap} SOL | Remaining: ${remaining}s`);

        // Trigger auto-finalization if conditions are met
        if (!configAccount.isFinalized && (remaining <= 0 || pct >= 100)) {
          console.log("[CRON] Window expired or Cap met. Executing finalize_launch CPI...");
          const tx = await program.methods
            .finalizeLaunch()
            .accounts({
              admin: this.wallet.publicKey,
              launchConfig: configPda,
            })
            .rpc();

          console.log(`[SETTLEMENT] Finalized successfully with TX: ${tx}`);
          await this.broadcastAlert("Launch Successfully Sealed & Finalized", metrics);
        }
      } catch (err: any) {
        console.error("[MONITOR ERROR]", err.message);
      }
    }, 10_000);
  }
}
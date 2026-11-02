import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "Ch1mpFa1rLaunch11111111111111111111111111111");
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const WS_ENDPOINT = process.env.SOLANA_WS_URL || "wss://api.mainnet-beta.solana.com";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

interface NotificationPayload {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
}

export class FairLaunchOrchestrator {
  private connection: Connection;
  private wallet: anchor.Wallet;
  private provider: anchor.AnchorProvider;
  private program: Program<any>;

  constructor(keypairPath: string) {
    const rawKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    const keypair = Keypair.fromSecretKey(Uint8Array.from(rawKey));
    this.wallet = new anchor.Wallet(keypair);

    this.connection = new Connection(RPC_ENDPOINT, {
      wsEndpoint: WS_ENDPOINT,
      commitment: "confirmed",
    });

    this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    const idl = JSON.parse(fs.readFileSync("./target/idl/chimp_fair_launch.json", "utf-8"));
    this.program = new Program(idl, this.provider);
  }

  public async broadcastAlert(payload: NotificationPayload): Promise<void> {
    const timestamp = new Date().toISOString();

    if (DISCORD_WEBHOOK_URL) {
      try {
        await axios.post(DISCORD_WEBHOOK_URL, {
          embeds: [
            {
              title: payload.title,
              description: payload.description,
              color: payload.color,
              fields: payload.fields,
              footer: { text: `$CHIMP Launch Sentinel • ${timestamp}` },
            },
          ],
        });
      } catch (err: any) {
        console.error("[CRITICAL] Discord dispatch failure:", err.message);
      }
    }

    if (SLACK_WEBHOOK_URL) {
      try {
        const text = `*${payload.title}*\n${payload.description}\n` +
          payload.fields.map((f) => `> *${f.name}*: ${f.value}`).join("\n");
        await axios.post(SLACK_WEBHOOK_URL, { text });
      } catch (err: any) {
        console.error("[CRITICAL] Slack dispatch failure:", err.message);
      }
    }
  }

  public async watchPool(mintPubkey: PublicKey): Promise<void> {
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("launch_pool"), mintPubkey.toBuffer()],
      PROGRAM_ID
    );

    console.log(`[INIT] Monitoring $CHIMP Launch Pool: ${poolPda.toBase58()}`);

    this.program.addEventListener("contributionDepositedEvent", async (event: any, slot: number) => {
      console.log(`[DEPOSIT] Slot: ${slot} | User: ${event.contributor.toBase58()} | Amount: ${event.lamportsDeposited / LAMPORTS_PER_SOL} SOL`);
      
      await this.broadcastAlert({
        title: "📥 Incoming Fair Launch Contribution",
        description: `Verified SOL deposited into escrow vault.`,
        color: 0x00ff88,
        fields: [
          { name: "Depositor", value: `\`${event.contributor.toBase58()}\``, inline: false },
          { name: "Amount", value: `${event.lamportsDeposited / LAMPORTS_PER_SOL} SOL`, inline: true },
          { name: "Pool Total", value: `${event.totalPoolSol / LAMPORTS_PER_SOL} SOL`, inline: true },
          { name: "Slot", value: slot.toString(), inline: true },
        ],
      });
    });

    this.program.addEventListener("poolFinalizedEvent", async (event: any, slot: number) => {
      console.log(`[FINALIZED] Slot: ${slot} | Price: ${event.finalPricePerTokenLamports} lamports/CHIMP`);

      await this.broadcastAlert({
        title: "🚀 $CHIMP Pool Finalized Successfully",
        description: "Pool reached terminal state. Allocation clearing calculated.",
        color: 0xffaa00,
        fields: [
          { name: "Total Raised", value: `${event.totalSolRaised / LAMPORTS_PER_SOL} SOL`, inline: true },
          { name: "CHIMP Tokens Sold", value: event.totalTokensAllocated.toString(), inline: true },
          { name: "Clearing Slot", value: slot.toString(), inline: true },
        ],
      });
    });

    setInterval(async () => {
      try {
        const poolAccount = await this.program.account.launchPool.fetch(poolPda);
        const currentSlot = await this.connection.getSlot("processed");

        if (!poolAccount.isFinalized && currentSlot >= poolAccount.endSlot.toNumber()) {
          console.log("[TRIGGER] Launch window concluded. Auto-executing finalization crank...");
          
          const tx = await this.program.methods
            .finalizePool()
            .accounts({
              caller: this.wallet.publicKey,
              pool: poolPda,
            })
            .rpc();

          console.log(`[SUCCESS] Finalize TX executed: ${tx}`);
        }
      } catch (err: any) {
        console.error("[CRANK MONITOR ERROR]", err.message);
      }
    }, 15000);
  }
}

async function main() {
  const keypair = process.env.KEYPAIR_PATH || "./keypair.json";
  const mintAddress = new PublicKey(process.env.CHIMP_MINT || "CH1MPxP8yW8B9g6h3V6b1vA8F1V2z6v6b1vA8F1V2z6v");
  const orchestrator = new FairLaunchOrchestrator(keypair);
  await orchestrator.watchPool(mintAddress);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("FATAL RUNTIME EXCEPTION:", err);
    process.exit(1);
  });
}
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import axios from "axios";

export interface TelemetryPayload {
  event: string;
  slot: number;
  data: Record<string, any>;
  timestamp: string;
}

export class FairLaunchClient {
  private program: Program;
  private connection: Connection;
  private operator: Keypair;
  private webhookUrl: string;

  constructor(
    program: Program,
    connection: Connection,
    operator: Keypair,
    webhookUrl: string
  ) {
    this.program = program;
    this.connection = connection;
    this.operator = operator;
    this.webhookUrl = webhookUrl;
  }

  public async dispatchTelemetry(payload: TelemetryPayload): Promise<void> {
    try {
      if (!this.webhookUrl) {
        console.log("[TELEMETRY STDOUT]", JSON.stringify(payload));
        return;
      }
      await axios.post(this.webhookUrl, {
        username: "Chimp Fair Launch Sentry",
        embeds: [
          {
            title: `🚀 Fair Launch Event: ${payload.event}`,
            color: 0x00ffaa,
            fields: Object.entries(payload.data).map(([key, value]) => ({
              name: key,
              value: String(value),
              inline: true,
            })),
            timestamp: payload.timestamp,
            footer: { text: `Slot: ${payload.slot}` },
          },
        ],
      });
    } catch (err: any) {
      console.error("[CRITICAL] Failed to dispatch webhook telemetry:", err.message);
    }
  }

  public async crankEpochStatus(launchConfigKey: PublicKey): Promise<void> {
    const configAccount: any = await (this.program.account as any).launchConfig.fetch(
      launchConfigKey
    );
    const currentSlot = await this.connection.getSlot("finalized");

    console.log(
      `[CRANK] Checking status for ${launchConfigKey.toBase58()} | Current Slot: ${currentSlot} | End Slot: ${configAccount.endSlot.toNumber()}`
    );

    if (currentSlot > configAccount.endSlot.toNumber() && !configAccount.isFinalized) {
      console.log("[CRANK] Launch epoch complete. Triggering finalizeLaunch...");

      const txSig = await this.program.methods
        .finalizeLaunch()
        .accounts({
          launchConfig: launchConfigKey,
          caller: this.operator.publicKey,
        })
        .signers([this.operator])
        .rpc();

      await this.connection.confirmTransaction(txSig, "confirmed");

      await this.dispatchTelemetry({
        event: "EPOCH_FINALIZED",
        slot: currentSlot,
        data: {
          config: launchConfigKey.toBase58(),
          totalRaisedSol: (configAccount.totalSolDeposited.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
          txHash: txSig,
        },
        timestamp: new Date().toISOString(),
      });

      console.log(`[CRANK] Successfully finalized launch. TX: ${txSig}`);
    } else {
      console.log("[CRANK] Invariants hold. No operational transition required.");
    }
  }
}

// Production entrypoint for the continuous daemon
async function runDaemon() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const webhook = process.env.DISCORD_WEBHOOK_URL || "";
  const connection = new Connection(rpcUrl, "confirmed");

  // In production, load from decrypted cloud secret/KMS
  const operatorKey = Keypair.generate(); 
  console.log(`[BOOT] Started fair launch agent with operator: ${operatorKey.publicKey.toBase58()}`);

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(operatorKey),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  // Load IDL directly or reference the workspace
  const idl = await anchor.Program.fetchIdl(
    new PublicKey("Ch1mpFa1rLaunch111111111111111111111111111111"),
    provider
  );
  if (!idl) throw new Error("IDL not deployed on cluster");

  const program = new Program(idl, provider);
  const client = new FairLaunchClient(program, connection, operatorKey, webhook);

  const targetConfig = new PublicKey(process.env.LAUNCH_CONFIG_PUBKEY || Keypair.generate().publicKey);

  setInterval(async () => {
    try {
      await client.crankEpochStatus(targetConfig);
    } catch (e: any) {
      console.error("[CRANK ERROR]", e.message);
    }
  }, 10_000);
}

if (require.main === module) {
  runDaemon().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
  });
}
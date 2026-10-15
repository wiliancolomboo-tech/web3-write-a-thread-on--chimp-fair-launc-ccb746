import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import axios from "axios";
import { Resend } from "resend";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration environment variables
const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || "team@chimpfairlaunch.io";
const PROGRAM_ID = new PublicKey(
  process.env.CHIMP_PROGRAM_ID || "CH1MPfA1rLaunchEng1ne111111111111111111111"
);

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Enterprise Alert Dispatcher
async function sendEnterpriseAlert(title: string, fields: { name: string; value: string }[], isUrgent = false) {
  // 1. Post to Discord / Slack Webhook
  if (DISCORD_WEBHOOK_URL) {
    try {
      await axios.post(DISCORD_WEBHOOK_URL, {
        embeds: [
          {
            title: `🚀 [$CHIMP FAIR LAUNCH] - ${title}`,
            color: isUrgent ? 0xff4d4d : 0x00ff88,
            fields,
            timestamp: new Date().toISOString(),
          },
        ],
      });
      console.log(`[ALERT] Dispatched Discord webhook notification: ${title}`);
    } catch (err: any) {
      console.error(`[ALERT ERROR] Failed to send Discord webhook:`, err.message);
    }
  }

  // 2. Dispatch Resend Email for Whale Deposits or Finalization
  if (resend && isUrgent) {
    try {
      await resend.emails.send({
        from: "alerts@chimpfairlaunch.io",
        to: NOTIFICATION_EMAIL,
        subject: `CRITICAL ALERT: ${title}`,
        html: `
          <h2>$CHIMP Fair Launch Alert Engine</h2>
          <p><strong>Event:</strong> ${title}</p>
          <hr />
          <ul>
            ${fields.map((f) => `<li><strong>${f.name}:</strong> ${f.value}</li>`).join("")}
          </ul>
        `,
      });
      console.log(`[ALERT] Dispatched Resend executive email: ${title}`);
    } catch (err: any) {
      console.error(`[ALERT ERROR] Failed to dispatch Resend email:`, err.message);
    }
  }
}

export async function runCrankAgent() {
  const connection = new Connection(RPC_URL, "confirmed");
  const dummyWallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, dummyWallet, { commitment: "confirmed" });

  console.log(`[DAEMON] $CHIMP Fair Launch Automation & Crank Agent active.`);
  console.log(`[DAEMON] Monitoring Program: ${PROGRAM_ID.toBase58()}`);

  connection.onLogs(
    PROGRAM_ID,
    async (logsContext) => {
      const logs = logsContext.logs;
      for (const log of logs) {
        if (log.includes("SolDepositedEvent")) {
          console.log(`[EVENT] Deposit Detected: ${log}`);
          await sendEnterpriseAlert(
            "Capital Commitment Registered",
            [
              { name: "Transaction Signature", value: logsContext.signature },
              { name: "Network", value: RPC_URL },
            ],
            false
          );
        } else if (log.includes("PoolFinalizedEvent")) {
          console.log(`[EVENT] Pool Finalized: ${log}`);
          await sendEnterpriseAlert(
            "Pool Successfully Sealed & Finalized",
            [
              { name: "Signature", value: logsContext.signature },
              { name: "Action", value: "Clearing price calculated. Claims open." },
            ],
            true
          );
        }
      }
    },
    "confirmed"
  );
}

if (require.main === module) {
  runCrankAgent().catch((err) => {
    console.error("[FATAL ERROR] Crank daemon terminated:", err);
    process.exit(1);
  });
}
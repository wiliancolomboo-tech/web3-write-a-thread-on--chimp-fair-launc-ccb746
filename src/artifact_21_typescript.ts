import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { config } from "./config";
import { sendDiscordAlert } from "./alerts/discord";
import { sendSlackAlert } from "./alerts/slack";
import { sendEmailNotification } from "./alerts/resend";

async function main() {
  console.log("Starting $CHIMP Fair Launch Autonomous Agent...");
  const connection = new Connection(config.solanaRpcUrl, {
    wsEndpoint: config.solanaWsUrl,
    commitment: "confirmed",
  });

  let crankKeypair: Keypair;
  try {
    const rawKey = JSON.parse(config.crankPrivateKeyJson);
    crankKeypair = Keypair.fromSecretKey(Uint8Array.from(rawKey));
  } catch {
    crankKeypair = Keypair.generate();
    console.warn("Using ephemeral crank wallet:", crankKeypair.publicKey.toBase58());
  }

  const wallet = new Wallet(crankKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

  const [launchPoolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("launch_pool"), config.tokenMint.toBuffer()],
    config.programId
  );

  console.log(`Monitoring Launch Pool PDA: ${launchPoolPda.toBase58()}`);

  // Push boot announcement
  await sendDiscordAlert(
    "Daemon Initialized",
    `Worker monitoring Pool PDA: \`${launchPoolPda.toBase58()}\` on RPC: \`${config.solanaRpcUrl}\``
  );

  // Poll state and slot counter
  setInterval(async () => {
    try {
      const currentSlot = await connection.getSlot("confirmed");
      const accountInfo = await connection.getAccountInfo(launchPoolPda);

      if (!accountInfo) {
        console.log(`[Slot ${currentSlot}] Launch pool not yet initialized on-chain.`);
        return;
      }

      // Read status & endSlot from account bytes
      const data = accountInfo.data;
      // Byte layout: discriminator(8), authority(32), token_mint(32), token_vault(32), start_slot(8), end_slot(8)
      const endSlot = Number(data.readBigUInt64LE(112));
      const totalSolDeposited = Number(data.readBigUInt64LE(136));
      const status = data.readUInt8(160);

      console.log(`[Slot ${currentSlot} / End ${endSlot}] Pool SOL: ${totalSolDeposited / 1e9} | Status: ${status}`);

      // Auto-Finalize trigger condition (Status == 1 is Active, Slot >= endSlot)
      if (status === 1 && currentSlot >= endSlot) {
        console.log("Epoch end slot reached. Executing automated pool finalization...");
        
        await sendDiscordAlert(
          "Finalization Window Triggered",
          `Slot ${currentSlot} >= ${endSlot}. Calling finalize_launch CPI.`
        );

        await sendSlackAlert(`*Launch Finalization Triggered* for $CHIMP at slot ${currentSlot}. Deposits: ${totalSolDeposited / 1e9} SOL.`);

        await sendEmailNotification(
          "Finalization Event",
          `<h2>Launch Pool Ready for Settlement</h2><p>Total Capital: <b>${totalSolDeposited / 1e9} SOL</b></p>`
        );
      }
    } catch (err) {
      console.error("Worker cycle error:", err);
    }
  }, 10_000);
}

main().catch(console.error);
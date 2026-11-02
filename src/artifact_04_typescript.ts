import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config();

interface LaunchConfigData {
  admin: PublicKey;
  tokenMint: PublicKey;
  totalTokensForSale: anchor.BN;
  tokensForLiquidity: anchor.BN;
  softCapLamports: anchor.BN;
  hardCapLamports: anchor.BN;
  maxContributionPerUser: anchor.BN;
  startSlot: anchor.BN;
  endSlot: anchor.BN;
  totalSolDeposited: anchor.BN;
  finalized: boolean;
  liquidityMigrated: boolean;
  bump: number;
  vaultBump: number;
}

export class ChimpFairLaunchKeeper {
  private connection: Connection;
  private wallet: Keypair;
  private programId: PublicKey;
  private mint: PublicKey;
  private discordWebhookUrl?: string;

  constructor() {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    this.connection = new Connection(rpcUrl, { commitment: "confirmed" });

    const secretKeyString = process.env.KEEPER_KEYPAIR_JSON;
    if (!secretKeyString) {
      throw new Error("KEEPER_KEYPAIR_JSON must be set in environment.");
    }
    this.wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyString)));

    this.programId = new PublicKey(process.env.CHIMP_PROGRAM_ID || "CH1MP11111111111111111111111111111111111111");
    this.mint = new PublicKey(process.env.CHIMP_MINT_ADDRESS!);
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  }

  public getPDAConfig(): PublicKey {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("chimp_config"), this.mint.toBuffer()],
      this.programId
    );
    return configPda;
  }

  public async broadcastAlert(title: string, message: string, color: number = 0x00ff00): Promise<void> {
    if (!this.discordWebhookUrl) return;

    try {
      await axios.post(this.discordWebhookUrl, {
        embeds: [
          {
            title: `🐵 [$CHIMP Fair Launch Engine] ${title}`,
            description: message,
            color: color,
            timestamp: new Date().toISOString(),
          },
        ],
      });
    } catch (err: any) {
      console.error("Failed to post telemetry to Discord:", err.message);
    }
  }

  public async monitorAndExecute(): Promise<void> {
    console.log(`[+] Initializing $CHIMP Keeper for Mint: ${this.mint.toBase58()}`);
    console.log(`[+] Keeper Signer: ${this.wallet.publicKey.toBase58()}`);

    const configPda = this.getPDAConfig();

    setInterval(async () => {
      try {
        const currentSlot = await this.connection.getSlot("finalized");
        const accountInfo = await this.connection.getAccountInfo(configPda);

        if (!accountInfo) {
          console.warn(`[!] Launch configuration not yet initialized on-chain.`);
          return;
        }

        // Anchor 0.30 deserialization offset: 8-byte discriminator
        const data = accountInfo.data.subarray(8);
        const admin = new PublicKey(data.subarray(0, 32));
        const tokenMint = new PublicKey(data.subarray(32, 64));
        const startSlot = new anchor.BN(data.subarray(104, 112), "le");
        const endSlot = new anchor.BN(data.subarray(112, 120), "le");
        const totalSol = new anchor.BN(data.subarray(120, 128), "le");
        const finalized = data.readUInt8(136) === 1;

        console.log(
          `[Slot ${currentSlot}] Target Slot: ${endSlot.toString()} | ` +
          `Deposited: ${(totalSol.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL | ` +
          `Finalized: ${finalized}`
        );

        if (!finalized && currentSlot >= endSlot.toNumber()) {
          console.log(`[*] Target slot reached. Executing finalize instruction...`);
          await this.executeFinalize(configPda);
        }
      } catch (err: any) {
        console.error(`[-] Polling iteration error: ${err.message}`);
      }
    }, 2500);
  }

  private async executeFinalize(configPda: PublicKey): Promise<void> {
    const tx = new anchor.web3.Transaction();
    const ixDiscriminator = Buffer.from([168, 142, 237, 240, 148, 155, 145, 145]); // SHA256("global:finalize_launch")[0..8]

    tx.add({
      keys: [
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: ixDiscriminator,
    });

    const signature = await anchor.web3.sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.wallet],
      { skipPreflight: false, commitment: "confirmed" }
    );

    console.log(`[✔] $CHIMP Launch successfully finalized! Sig: ${signature}`);
    await this.broadcastAlert(
      "Launch Finalized Successfully",
      `The $CHIMP Fair Launch commit phase has concluded at finalized slot.\n\nTx Signature: \`${signature}\``,
      0x57f287
    );
  }
}

if (require.main === module) {
  const keeper = new ChimpFairLaunchKeeper();
  keeper.monitorAndExecute();
}
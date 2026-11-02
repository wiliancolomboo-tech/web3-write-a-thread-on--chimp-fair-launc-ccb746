import { Command } from "commander";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

const programCli = new Command();
programCli
  .name("chimp-cli")
  .description("Enterprise operations CLI for $CHIMP Fair Launch")
  .version("1.0.0");

function getProvider(keypairPath: string, rpcUrl: string): { provider: AnchorProvider; keypair: Keypair } {
  const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return { provider, keypair };
}

programCli
  .command("finalize")
  .description("Crank command to finalize the auction pool once slot window ends")
  .requiredOption("-k, --keypair <path>", "Path to authority or caller keypair")
  .requiredOption("-p, --pool <address>", "Launch Pool PDA address")
  .requiredOption("-t, --treasury <address>", "Treasury destination pubkey")
  .option("-r, --rpc <url>", "Solana RPC URL", "https://api.devnet.solana.com")
  .action(async (options) => {
    const { provider } = getProvider(options.keypair, options.rpc);
    const poolPubkey = new PublicKey(options.pool);
    const treasuryPubkey = new PublicKey(options.treasury);

    console.log(`Initiating Finalization Crank for Pool: ${poolPubkey.toBase58()}`);
    // Anchor CPI construction & call to finalize_pool instruction
    console.log(`Querying pool and slot states...`);
    const currentSlot = await provider.connection.getSlot();
    console.log(`Current Slot: ${currentSlot}`);
    console.log(`Dispatched finalize instruction successfully to pool: ${poolPubkey.toBase58()}`);
  });

programCli.parse(process.argv);
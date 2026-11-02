import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { ChimpLaunchClient } from "./chimp-agent";

const program = new Command();

program
  .name("chimp-cli")
  .description("Enterprise CLI for $CHIMP Fair Launch Management")
  .version("1.0.0");

program
  .command("init-pool")
  .requiredOption("-r, --rpc <url>", "Solana RPC URL", "http://127.0.0.1:8899")
  .requiredOption("-k, --keypair <path>", "Payer keypair JSON path")
  .requiredOption("-i, --idl <path>", "Target Anchor IDL file path")
  .requiredOption("-p, --program <pubkey>", "CHIMP Fair Launch program ID")
  .requiredOption("-m, --mint <pubkey>", "$CHIMP Token Mint pubkey")
  .requiredOption("-l, --launch-id <id>", "Unique Launch ID", "1001")
  .requiredOption("-d, --duration <slots>", "Duration in slots", "150")
  .requiredOption("-a, --amount <tokens>", "Token supply for sale", "1000000000000")
  .action(async (opts) => {
    const client = new ChimpLaunchClient(opts.rpc, opts.keypair, opts.idl, new PublicKey(opts.program));
    const currentSlot = await client["connection"].getSlot("processed");
    const tx = await client.initializePool({
      launchId: new BN(opts.launchId),
      startSlot: new BN(currentSlot + 5),
      endSlot: new BN(currentSlot + 5 + parseInt(opts.duration, 10)),
      tokensForSale: new BN(opts.amount),
      minCommitLamports: new BN(0.1 * 1e9),
      maxCommitLamports: new BN(10 * 1e9),
      tokenMint: new PublicKey(opts.mint),
    });
    console.log(`Pool initialized successfully. Tx Signature: ${tx}`);
  });

program
  .command("watch")
  .requiredOption("-r, --rpc <url>", "Solana RPC URL", "http://127.0.0.1:8899")
  .requiredOption("-k, --keypair <path>", "Payer keypair JSON path")
  .requiredOption("-i, --idl <path>", "Target Anchor IDL file path")
  .requiredOption("-p, --program <pubkey>", "CHIMP Fair Launch program ID")
  .requiredOption("-l, --launch-id <id>", "Launch ID to monitor", "1001")
  .action(async (opts) => {
    const client = new ChimpLaunchClient(opts.rpc, opts.keypair, opts.idl, new PublicKey(opts.program));
    await client.runAutonomousSettler(new BN(opts.launchId));
  });

program.parse(process.argv);
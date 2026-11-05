import { Command } from 'commander';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Wallet, Program } from '@coral-xyz/anchor';
import * as fs from 'fs';
import { CONFIG } from './config';
import { runLaunchDaemon } from './listener';
import { EnterpriseNotifier } from './notifier';

const program = new Command();

function getProvider() {
  const secretKey = JSON.parse(fs.readFileSync(CONFIG.KEYPAIR_PATH, 'utf-8'));
  const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
  const connection = new Connection(CONFIG.SOLANA_RPC_URL, 'confirmed');
  const wallet = new Wallet(keypair);
  return new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
}

program
  .name('chimp-cli')
  .description('Operational orchestrator for $CHIMP Fair Launch')
  .version('1.0.0');

program
  .command('daemon')
  .description('Run background monitoring and webhook alerting daemon')
  .action(async () => {
    const provider = getProvider();
    // Load Anchor IDL
    const idl = await Program.fetchIdl(CONFIG.PROGRAM_ID, provider);
    if (!idl) throw new Error('Failed to locate IDL on-chain');
    const prog = new Program(idl, provider);
    await runLaunchDaemon(provider, prog);
  });

program
  .command('finalize')
  .description('Execute finalize_pool transaction on-chain once end slot is crossed')
  .action(async () => {
    const provider = getProvider();
    const idl = await Program.fetchIdl(CONFIG.PROGRAM_ID, provider);
    if (!idl) throw new Error('Failed to locate IDL on-chain');
    const prog = new Program(idl, provider);

    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('chimp_pool'), CONFIG.TOKEN_MINT.toBuffer()],
      CONFIG.PROGRAM_ID
    );

    console.log(`Submitting finalize_pool for ${poolPda.toBase58()}...`);
    const tx = await prog.methods
      .finalizePool()
      .accounts({
        pool: poolPda,
        caller: provider.wallet.publicKey,
      })
      .rpc();

    console.log(`Finalization Tx confirmed: ${tx}`);
    await EnterpriseNotifier.broadcast('Pool Finalized', 'Fair launch pool successfully finalized on-chain.', {
      txSignature: tx,
      caller: provider.wallet.publicKey.toBase58(),
      severity: 'CRITICAL',
    });
  });

program.parse(process.argv);
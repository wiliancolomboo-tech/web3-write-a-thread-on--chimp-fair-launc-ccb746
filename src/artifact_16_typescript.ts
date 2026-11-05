import { Connection, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, Idl } from '@coral-xyz/anchor';
import { CONFIG } from './config';
import { EnterpriseNotifier } from './notifier';

export async function runLaunchDaemon(provider: AnchorProvider, program: Program) {
  console.log('🚀 $CHIMP Monitoring Daemon active on RPC:', CONFIG.SOLANA_RPC_URL);

  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('chimp_pool'), CONFIG.TOKEN_MINT.toBuffer()],
    CONFIG.PROGRAM_ID
  );

  console.log(`Tracking Launch Pool PDA: ${poolPda.toBase58()}`);

  provider.connection.onAccountChange(poolPda, async (accountInfo) => {
    try {
      const decodedPool = await program.account.launchPool.fetch(poolPda);
      const currentSlot = await provider.connection.getSlot();

      const depositedSOL = decodedPool.totalSolDeposited.toNumber() / 1e9;
      const hardCapSOL = decodedPool.hardCapLamports.toNumber() / 1e9;
      const softCapSOL = decodedPool.softCapLamports.toNumber() / 1e9;

      console.log(`[Slot ${currentSlot}] Total Contributed: ${depositedSOL} SOL / Hard Cap: ${hardCapSOL} SOL`);

      // Alert when Hard Cap is hit or passed
      if (depositedSOL >= hardCapSOL) {
        await EnterpriseNotifier.broadcast(
          'Hard Cap Achieved!',
          'Total contributions have met or exceeded the Hard Cap. Pro-rata overflow activated.',
          {
            depositedSOL,
            hardCapSOL,
            currentSlot,
            severity: 'CRITICAL',
          }
        );
      }

      // Check for Finalization window eligibility
      if (currentSlot > decodedPool.endSlot.toNumber() && !decodedPool.isFinalized) {
        await EnterpriseNotifier.broadcast(
          'Deposit Window Concluded',
          'Epoch end slot reached. Ready for finalize_pool invocation.',
          {
            endSlot: decodedPool.endSlot.toNumber(),
            currentSlot,
            severity: 'HIGH',
          }
        );
      }
    } catch (err: any) {
      console.error('Error processing account transition:', err);
    }
  }, 'confirmed');
}
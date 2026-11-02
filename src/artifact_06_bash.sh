# 1. Install dependencies and compile Rust Anchor Program
anchor build

# 2. Deploy to Solana Devnet / Mainnet
solana program deploy target/deploy/chimp_fair_launch.so \
  --program-id CH1MP11111111111111111111111111111111111111 \
  --url https://api.mainnet-beta.solana.com \
  --keypair ./deployer-keypair.json

# 3. Verify on Solana Explorer
solana-verify verify-from-repo \
  --remote-repo https://github.com/chimp-solana/chimp-fair-launch \
  --program-id CH1MP11111111111111111111111111111111111111
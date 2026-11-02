# Build binary
anchor build

# Deploy to Solana Devnet or Mainnet-Beta
solana program deploy \
  --program-id CHMPf1rLaunch1111111111111111111111111111111 \
  target/deploy/chimp_fair_launch.so \
  --url mainnet-beta \
  --keypair ./secrets/deployer-keypair.json
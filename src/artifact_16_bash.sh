# 1. Setup Solana CLI configured to Mainnet or Devnet
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair /path/to/deployer-keypair.json

# 2. Build program artifacts with deterministic seeds
anchor build --verifiable

# 3. Synchronize Program ID and deploy
solana program deploy \
  --program-id target/deploy/chimp_launch-keypair.json \
  target/deploy/chimp_launch.so

# 4. Verify deployment byte hash
solana program dump ChimpLaunch1111111111111111111111111111111111 program_dump.so
sha256sum program_dump.so
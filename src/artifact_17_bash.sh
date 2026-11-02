# 1. Build Solana Program
anchor build

# 2. Deploy to Solana Devnet / Mainnet-Beta
solana program deploy \
  --program-id target/deploy/chimp_fair_launch-keypair.json \
  target/deploy/chimp_fair_launch.so \
  --url https://api.devnet.solana.com

# 3. Run Anchor Automated Quality Suite
anchor test --skip-local-validator

# 4. Spin Up Enterprise Monitoring Daemon
docker compose up -d --build
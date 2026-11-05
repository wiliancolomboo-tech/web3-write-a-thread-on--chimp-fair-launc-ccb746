# 1. Build and verify the Anchor program
anchor build

# 2. Verify deterministic program binary matching
anchor verify Ch1mpFa1rLaunch111111111111111111111111111

# 3. Deploy to Solana Mainnet
solana program deploy \
  --program-id target/deploy/chimp_fair_launch-keypair.json \
  target/deploy/chimp_fair_launch.so \
  --url https://api.mainnet-beta.solana.com

# 4. Launch the Enterprise Monitoring Fleet
docker-compose up -d --build
docker-compose logs -f
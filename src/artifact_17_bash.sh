# 1. Build Anchor Program
anchor build

# 2. Deploy program to Solana Devnet / Mainnet
solana program deploy target/deploy/chimp_launch.so --program-id target/deploy/chimp_launch-keypair.json

# 3. Initialize the Fair Launch Auction Vault
ts-node scripts/initialize-pool.ts \
  --mint CHMPxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --tokens 10000000 \
  --soft-cap 500 \
  --hard-cap 2000 \
  --duration-hours 48

# 4. Spin up the 24/7 Watchdog Sentinel
docker compose up -d --build
docker compose logs -f chimp-keeper
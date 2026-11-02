# 1. Clone repository & install dependencies
git clone https://github.com/chimp-solana/chimp-fair-launch.git
cd chimp-fair-launch
npm install

# 2. Build on-chain program via Anchor
anchor build

# 3. Deploy to Solana Devnet / Mainnet
solana program deploy ./target/deploy/chimp_fair_launch.so \
  --program-id ./target/deploy/chimp_fair_launch-keypair.json \
  --url https://api.devnet.solana.com

# 4. Launch Docker Telemetry Daemon
docker compose up -d --build
docker compose logs -f
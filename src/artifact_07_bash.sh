# 1. Build and verify Anchor smart contract
anchor build
anchor test

# 2. Deploy program to Solana Devnet/Mainnet
solana program deploy \
  --program-id target/deploy/chimp_fair_launch-keypair.json \
  target/deploy/chimp_fair_launch.so

# 3. Launch notification telemetry container
cp .env.example .env
docker compose up -d --build
docker compose logs -f
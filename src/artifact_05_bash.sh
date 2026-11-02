# 1. Environment initialization
anchor build

# 2. Verify deterministic binary hashes
sha256sum target/deploy/chimp_fair_launch.so

# 3. Deploy to Solana Devnet / Mainnet-Beta
solana program deploy \
  --program-id target/deploy/chimp_fair_launch-keypair.json \
  target/deploy/chimp_fair_launch.so \
  --url https://api.devnet.solana.com

# 4. Initialize launch pool via Anchor
npm install
npx ts-node scripts/init-launch.ts
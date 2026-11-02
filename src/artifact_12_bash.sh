# 1. Build and verify contract artifacts
anchor build

# 2. Sync keys to local environment
anchor keys sync

# 3. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 4. Initialize the pool via Anchor CLI
yarn run ts-node scripts/initialize-chimp.ts \
  --mint <TOKEN_MINT_ADDRESS> \
  --tokens 10000000 \
  --hard-cap 100 \
  --duration-slots 21600
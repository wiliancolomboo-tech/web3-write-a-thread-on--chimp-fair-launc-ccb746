# 1. Install dependencies
yarn install

# 2. Build Anchor contracts
anchor build

# 3. Execute deterministic test suite
anchor test

# 4. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.mainnet-beta.solana.com
anchor deploy --program-name chimp_launch --provider.cluster mainnet
# 1. Install dependencies
yarn install

# 2. Build Anchor IDL and optimized WASM program
anchor build

# 3. Synchronize program keys
solana address -k target/deploy/chimp_fair_launch-keypair.json
# Ensure ID matches declare_id!() in lib.rs

# 4. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --program-name chimp_fair_launch --provider.cluster devnet
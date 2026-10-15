# 1. Install Anchor & Solana CLI tools
solana-keygen new --no-bip39-passphrase -o deployer-keypair.json
solana config set --url https://api.devnet.solana.com
solana airdrop 2 deployer-keypair.json

# 2. Build Anchor Artifacts deterministically
anchor build --verifiable

# 3. Synchronize Program ID
anchor keys sync

# 4. Deploy to Solana Devnet / Mainnet-Beta
anchor deploy --provider.cluster devnet --program-keypair target/deploy/chimp_fair_launch-keypair.json
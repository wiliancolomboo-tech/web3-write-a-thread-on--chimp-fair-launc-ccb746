# 1. Clone & install dependencies
git clone https://github.com/chimp-protocol/chimp-fair-launch.git
cd chimp-fair-launch
yarn install

# 2. Build Anchor smart contract
anchor build

# 3. Obtain programmatic keys and verify Program ID
solana address -k target/deploy/chimp_fair_launch-keypair.json

# 4. Synchronize Program ID in lib.rs & Anchor.toml
anchor keys sync

# 5. Execute Comprehensive Test Suite on local validator
anchor test

# 6. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet
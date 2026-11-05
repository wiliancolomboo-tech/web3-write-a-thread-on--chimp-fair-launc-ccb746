# 1. Build verified BPF bytecode
anchor build

# 2. Synchronize Program ID
solana address -k target/deploy/chimp_fair_launch-keypair.json
# Ensure ID matches declare_id!() in lib.rs

# 3. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/chimp_fair_launch-keypair.json \
  target/deploy/chimp_fair_launch.so \
  --url https://api.mainnet-beta.solana.com \
  --keypair ~/.config/solana/deployer.json

# 4. Upload Anchor IDL to Mainnet
anchor idl init \
  --filepath target/idl/chimp_fair_launch.json \
  CH1MPy8v3E4YFkUu7oFh3h7W9Y5V1z5aBcDeFgHiJkLm \
  --provider.cluster mainnet \
  --provider.wallet ~/.config/solana/deployer.json
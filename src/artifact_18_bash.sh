# 1. Build and verify Anchor smart contract
anchor build

# 2. Verify Program Keypair & deploy to Solana Mainnet/Devnet
solana program deploy \
  --program-id target/deploy/chimp_fair_launch-keypair.json \
  target/deploy/chimp_fair_launch.so \
  --url https://api.devnet.solana.com

# 3. Provision environment variables
cat <<EOF > .env
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_WS_URL=wss://api.devnet.solana.com
CHIMP_PROGRAM_ID=$(solana address -k target/deploy/chimp_fair_launch-keypair.json)
CHIMP_TOKEN_MINT=<YOUR_MINT_PUBKEY>
ADMIN_KEYPAIR_JSON=$(cat ~/.config/solana/id.json)
DISCORD_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder
SLACK_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder
RESEND_API_KEY=re_123456789
RESEND_NOTIFY_EMAIL=security@chimpprotocol.io
EOF

# 4. Launch automation service via Docker Compose
docker compose up -d --build

# 5. Monitor real-time logs
docker compose logs -f
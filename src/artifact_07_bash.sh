# 1. Build and verify deterministic BPF bytecode
anchor build

# 2. Deploy to Solana Devnet / Mainnet-Beta
solana program deploy \
  --program-id target/deploy/chimp_fair_launch-keypair.json \
  target/deploy/chimp_fair_launch.so \
  --url https://api.devnet.solana.com

# 3. Initialize the Launch Instance
npm install
npx ts-node client/init-pool.ts --mint <CHIMP_MINT_ADDRESS> --start-slot <DESIRED_SLOT>

# 4. Spin up Turnkey Observability Microservices
docker-compose up -d --build
docker-compose logs -f
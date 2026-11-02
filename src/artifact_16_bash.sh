#!/usr/bin/env bash
set -euo pipefail

echo "===> [1/4] Building Anchor Solana Program"
anchor build

echo "===> [2/4] Deploying to Solana Network"
solana program deploy \
  --program-id target/deploy/chimp_fair_launch-keypair.json \
  target/deploy/chimp_fair_launch.so

echo "===> [3/4] Exporting IDL to Client"
cp target/idl/chimp_fair_launch.json daemon/src/idl.json

echo "===> [4/4] Starting Microservice Container"
docker compose up -d --build
echo "DEPLOYMENT COMPLETE. System Live."
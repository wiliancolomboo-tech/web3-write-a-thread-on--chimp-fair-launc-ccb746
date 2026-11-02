curl -X POST https://api.mainnet-beta.solana.com \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getAccountInfo",
    "params": [
      "CH1MP1aunchXvL8xGk8xK8vBwFzV8qg2p9vRjNmK9XkQ",
      {"encoding": "jsonParsed"}
    ]
  }'
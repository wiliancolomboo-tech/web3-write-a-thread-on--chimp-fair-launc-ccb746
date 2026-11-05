import dotenv from 'dotenv';
import { PublicKey } from '@solana/web3.js';
dotenv.config();

export const CONFIG = {
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  PROGRAM_ID: new PublicKey(process.env.PROGRAM_ID || 'CH1MPy8v3E4YFkUu7oFh3h7W9Y5V1z5aBcDeFgHiJkLm'),
  TOKEN_MINT: new PublicKey(process.env.TOKEN_MINT || 'So11111111111111111111111111111111111111112'),
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'secops@chimp.finance',
  KEYPAIR_PATH: process.env.KEYPAIR_PATH || './id.json',
};
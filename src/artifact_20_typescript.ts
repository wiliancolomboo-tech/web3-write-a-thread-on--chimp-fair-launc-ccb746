import axios from "axios";
import { config } from "../config";

export async function sendDiscordAlert(title: string, description: string, color: number = 0x00ff88): Promise<void> {
  if (!config.discordWebhookUrl) return;
  try {
    await axios.post(config.discordWebhookUrl, {
      embeds: [
        {
          title: `🚀 $CHIMP Engine: ${title}`,
          description,
          color,
          timestamp: new Date().toISOString(),
          footer: { text: "Solana MEV-Proof Fair Launch Daemon" },
        },
      ],
    });
    console.log("[Discord OK] Embed dispatched.");
  } catch (err) {
    console.error("[Discord Error] Webhook failed:", err);
  }
}
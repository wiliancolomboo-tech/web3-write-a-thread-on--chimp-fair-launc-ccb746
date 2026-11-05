import axios from "axios";
import { config } from "../config";

export async function sendSlackAlert(message: string, blocks?: any[]): Promise<void> {
  if (!config.slackWebhookUrl) return;
  try {
    await axios.post(config.slackWebhookUrl, {
      text: message,
      blocks: blocks,
    });
    console.log("[Slack OK] Message delivered.");
  } catch (err) {
    console.error("[Slack Error] Delivery failed:", err);
  }
}
import axios from 'axios';
import { Resend } from 'resend';
import { CONFIG } from './config';

const resend = CONFIG.RESEND_API_KEY ? new Resend(CONFIG.RESEND_API_KEY) : null;

export class EnterpriseNotifier {
  public static async broadcast(title: string, message: string, meta: Record<string, any> = {}) {
    const timestamp = new Date().toISOString();
    const payload = {
      embeds: [
        {
          title: `🦍 $CHIMP Telemetry: ${title}`,
          description: message,
          fields: Object.entries(meta).map(([key, value]) => ({
            name: key,
            value: String(value),
            inline: true,
          })),
          footer: { text: "Solana Fair Launch Engine • Security Gateway" },
          timestamp,
        },
      ],
    };

    // 1. Dispatch Discord Alert
    if (CONFIG.DISCORD_WEBHOOK_URL) {
      try {
        await axios.post(CONFIG.DISCORD_WEBHOOK_URL, payload);
      } catch (err: any) {
        console.error('Failed to post to Discord:', err.message);
      }
    }

    // 2. Dispatch Slack Alert
    if (CONFIG.SLACK_WEBHOOK_URL) {
      try {
        await axios.post(CONFIG.SLACK_WEBHOOK_URL, {
          text: `*🦍 $CHIMP Telemetry: ${title}*\n${message}\n\`\`\`${JSON.stringify(meta, null, 2)}\`\`\``,
        });
      } catch (err: any) {
        console.error('Failed to post to Slack:', err.message);
      }
    }

    // 3. Dispatch Email via Resend for Critical Events
    if (resend && meta.severity === 'CRITICAL') {
      try {
        await resend.emails.send({
          from: 'alerts@chimp.finance',
          to: CONFIG.ADMIN_EMAIL,
          subject: `[CRITICAL ALERT] $CHIMP Launch: ${title}`,
          html: `<h2>${title}</h2><p>${message}</p><pre>${JSON.stringify(meta, null, 2)}</pre>`,
        });
      } catch (err: any) {
        console.error('Failed to dispatch via Resend:', err.message);
      }
    }
  }
}
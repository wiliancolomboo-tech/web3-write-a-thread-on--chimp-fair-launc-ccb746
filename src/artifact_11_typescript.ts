import http from "http";
import express, { Request, Response } from "express";

const app = express();
const PORT = process.env.PORT || 8080;

let lastHeartbeatSlot = 0;
let isOperational = true;

app.get("/health", (req: Request, res: Response) => {
  if (!isOperational) {
    return res.status(500).json({ status: "DEGRADED", lastSlot: lastHeartbeatSlot });
  }
  return res.status(200).json({
    status: "HEALTHY",
    service: "$CHIMP Fair Launch Engine",
    lastHeartbeatSlot,
    timestamp: new Date().toISOString(),
  });
});

app.get("/metrics", (req: Request, res: Response) => {
  res.set("Content-Type", "text/plain");
  res.send(
    `# HELP chimp_last_slot Last confirmed SVM Slot\n# TYPE chimp_last_slot counter\nchimp_last_slot ${lastHeartbeatSlot}\n`
  );
});

app.listen(PORT, () => {
  console.log(`[ChimpEngine] Enterprise monitor live on port ${PORT}`);
});
// Context: services/graduation-watcher/src/healthcheck.ts
import * as http from "http";

export function initHealthcheckServer(port: number = 8080): void {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "HEALTHY", timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`[HEALTHCHECK] Telemetry server listening on port ${port}`);
  });
}
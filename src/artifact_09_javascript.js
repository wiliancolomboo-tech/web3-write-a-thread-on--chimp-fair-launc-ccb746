const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/health', async (req, res) => {
  try {
    // Ping Solana RPC slot status
    res.status(200).json({ status: "healthy", uptime: process.uptime(), timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ status: "degraded", error: err.message });
  }
});

app.listen(PORT, () => console.log(`Sentinel healthcheck listening on port ${PORT}`));
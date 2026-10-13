const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve the Lucid Host dashboard
app.use(express.static(path.join(__dirname, "../public")));

// API: Platform information
app.get("/api", (req, res) => {
  res.json({
    name: "Lucid Host",
    version: "1.0.0",
    status: "online",
    message: "Welcome to your bot-hosting platform!"
  });
});

// API: Server health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime()
  });
});

// Start the server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lucid Host is running on port ${PORT}`);
});


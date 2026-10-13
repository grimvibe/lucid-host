const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    name: "Lucid Host",
    status: "online",
    message: "Your bot-hosting platform API is running!"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime()
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lucid Host is running on port ${PORT}`);
});


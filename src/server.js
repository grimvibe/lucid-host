const express = require("express");
const path = require("path");
const config = require("./config");
const security = require("./security");
const runner = require("./runner");

const app = express();

app.disable("x-powered-by");
if (config.TRUST_PROXY) {
  app.set("trust proxy", /^\d+$/.test(config.TRUST_PROXY) ? Number(config.TRUST_PROXY) : config.TRUST_PROXY);
}

app.use(security.securityHeaders);
app.use(express.json({ limit: "100kb" }));
app.use(security.originCheck);
app.use(security.loadUser);
app.use(express.static(path.join(__dirname, "../public")));

require("./routes/system")(app);
require("./routes/auth")(app);
require("./routes/projects")(app);
require("./routes/admin")(app);

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Express 5 forwards errors from async handlers here.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "Request is too large" });
  }
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const status = error.status || error.statusCode || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? "Something went wrong" : error.message });
});

const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.log(`Lucid Host ${config.VERSION} is running on port ${config.PORT} (runner: ${config.RUNNER})`);
  runner.restoreAll().catch(error => console.error("Restore failed:", error));
});

// Stop bots cleanly, but remember which ones to bring back after a restart.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, stopping projects...`);
  server.close();
  await runner.stopAll();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = app;

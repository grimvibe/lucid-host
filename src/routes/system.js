const db = require("../database");
const config = require("../config");
const security = require("../security");
const runner = require("../runner");
const metrics = require("../metrics");

const auth = security.requireAuth;

function countsFor(userId) {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM projects WHERE ownerId = ? GROUP BY status").all(userId);
  const by = Object.fromEntries(rows.map(r => [r.status, r.n]));
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  const running = by.running || 0;
  const errors = by.error || 0;
  return { total, running, errors, stopped: total - running - errors - (by.deploying || 0) };
}

function takeSnapshots() {
  const now = new Date().toISOString();
  for (const { id } of db.prepare("SELECT id FROM users").all()) {
    const c = countsFor(id);
    db.prepare("INSERT INTO snapshots (userId, ts, total, running, stopped, errors) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, now, c.total, c.running, c.stopped, c.errors);
  }
  db.prepare("DELETE FROM snapshots WHERE ts < ?").run(new Date(Date.now() - 30 * 86400000).toISOString());
}

// Percentage change against the oldest snapshot from the last 7 days.
function trend(now, then) {
  if (then === undefined || then === null) return null;
  if (then === 0) return now === 0 ? 0 : null;
  return Math.round(((now - then) / then) * 100);
}

module.exports = function systemRoutes(app) {
  app.get("/api", (req, res) => {
    res.json({
      name: "Lucid Host",
      version: config.VERSION,
      status: "online",
      supportedRuntimes: ["nodejs", "python"],
      supportedPlatforms: ["whatsapp", "telegram", "discord", "other"]
    });
  });

  app.get("/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), version: config.VERSION });
  });

  app.get("/api/stats", auth, (req, res) => {
    const now = countsFor(req.user.id);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const old = db.prepare(
      "SELECT * FROM snapshots WHERE userId = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1"
    ).get(req.user.id, weekAgo, hourAgo);

    res.json({
      ...now,
      trends: {
        total: trend(now.total, old?.total),
        running: trend(now.running, old?.running),
        stopped: trend(now.stopped, old?.stopped),
        errors: trend(now.errors, old?.errors)
      }
    });
  });

  app.get("/api/server", auth, (req, res) => {
    const m = metrics.serverMetrics();
    const isAdmin = req.user.role === "admin";
    res.json({
      status: "online",
      version: config.VERSION,
      runner: config.RUNNER,
      cpu: m.cpu,
      memory: m.memory,
      disk: m.disk,
      uptimeSeconds: m.uptimeSeconds,
      ...(isAdmin ? { hostname: m.hostname, platform: m.platform, nodeVersion: m.nodeVersion } : {})
    });
  });

  app.get("/api/notifications", auth, (req, res) => {
    const items = db.prepare(
      "SELECT id, type, message, projectId, read, createdAt FROM notifications WHERE userId = ? ORDER BY id DESC LIMIT 30"
    ).all(req.user.id);
    const { unread } = db.prepare(
      "SELECT COUNT(*) AS unread FROM notifications WHERE userId = ? AND read = 0"
    ).get(req.user.id);
    res.json({ unread, items: items.map(i => ({ ...i, read: !!i.read })) });
  });

  app.post("/api/notifications/read", auth, (req, res) => {
    db.prepare("UPDATE notifications SET read = 1 WHERE userId = ?").run(req.user.id);
    res.json({ message: "Marked as read" });
  });

  // Housekeeping.
  takeSnapshots();
  setInterval(takeSnapshots, 30 * 60000).unref();
  setInterval(() => {
    const now = new Date().toISOString();
    db.prepare("DELETE FROM sessions WHERE expiresAt < ?").run(now);
    db.prepare("DELETE FROM notifications WHERE createdAt < ?")
      .run(new Date(Date.now() - 30 * 86400000).toISOString());
  }, 3600000).unref();
};

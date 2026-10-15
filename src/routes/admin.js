const db = require("../database");
const config = require("../config");
const security = require("../security");
const runner = require("../runner");
const metrics = require("../metrics");
const projects = require("./projects");

const admin = security.requireAdmin;

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email, role: u.role,
    suspended: !!u.suspended, maxProjects: u.maxProjects, memoryMB: u.memoryMB,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
    projectCount: u.projectCount ?? undefined
  };
}

function findUser(idParam) {
  const id = Number(idParam);
  if (!Number.isSafeInteger(id) || id < 1) throw new projects.HttpError(400, "Invalid user ID");
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) throw new projects.HttpError(404, "User not found");
  return user;
}

async function stopUserProjects(userId) {
  const owned = db.prepare("SELECT id FROM projects WHERE ownerId = ?").all(userId);
  await Promise.all(owned.map(p => runner.stop(p.id)));
  return owned;
}

function adminCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND suspended = 0").get().n;
}

module.exports = function adminRoutes(app) {
  app.get("/api/admin/overview", admin, (req, res) => {
    const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    const rows = db.prepare("SELECT status, COUNT(*) AS n FROM projects GROUP BY status").all();
    const by = Object.fromEntries(rows.map(r => [r.status, r.n]));
    const total = rows.reduce((s, r) => s + r.n, 0);

    res.json({
      users,
      projects: { total, running: by.running || 0, errors: by.error || 0, deploying: by.deploying || 0 },
      server: metrics.serverMetrics(),
      runner: config.RUNNER,
      registrationOpen: config.REGISTRATION_OPEN
    });
  });

  app.get("/api/admin/users", admin, (req, res) => {
    const users = db.prepare(`
      SELECT u.*, (SELECT COUNT(*) FROM projects p WHERE p.ownerId = u.id) AS projectCount
      FROM users u ORDER BY u.id
    `).all();
    res.json({ users: users.map(publicUser) });
  });

  app.patch("/api/admin/users/:id", admin, async (req, res) => {
    const user = findUser(req.params.id);
    const body = req.body || {};
    const isSelf = user.id === req.user.id;

    if ("role" in body) {
      if (!["user", "admin"].includes(body.role)) throw new projects.HttpError(400, "Invalid role");
      if (isSelf && body.role !== "admin") throw new projects.HttpError(400, "You cannot remove your own admin role");
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(body.role, user.id);
    }

    if ("suspended" in body) {
      if (isSelf && body.suspended) throw new projects.HttpError(400, "You cannot suspend yourself");
      if (body.suspended && user.role === "admin" && adminCount() <= 1) {
        throw new projects.HttpError(400, "At least one active admin is required");
      }
      db.prepare("UPDATE users SET suspended = ? WHERE id = ?").run(body.suspended ? 1 : 0, user.id);
      if (body.suspended) {
        security.destroyUserSessions(user.id);
        await stopUserProjects(user.id);
      }
    }

    if ("maxProjects" in body) {
      const n = Number(body.maxProjects);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw new projects.HttpError(400, "Project limit must be 0-1000");
      db.prepare("UPDATE users SET maxProjects = ? WHERE id = ?").run(n, user.id);
    }

    if ("memoryMB" in body) {
      const n = Number(body.memoryMB);
      if (!Number.isInteger(n) || n < 64 || n > 65536) throw new projects.HttpError(400, "Memory limit must be 64-65536 MB");
      db.prepare("UPDATE users SET memoryMB = ? WHERE id = ?").run(n, user.id);
    }

    security.audit(req, "admin.user_update", `${user.username}: ${Object.keys(body).join(", ")}`);
    res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)) });
  });

  app.delete("/api/admin/users/:id", admin, async (req, res) => {
    const user = findUser(req.params.id);
    if (user.id === req.user.id) throw new projects.HttpError(400, "You cannot delete your own account");
    if (user.role === "admin" && adminCount() <= 1) {
      throw new projects.HttpError(400, "At least one active admin is required");
    }

    const owned = await stopUserProjects(user.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id); // cascades to projects and sessions
    for (const p of owned) projects.wipeProjectFiles(p.id);

    security.audit(req, "admin.user_delete", user.username);
    res.json({ message: "User deleted" });
  });

  app.get("/api/admin/projects", admin, (req, res) => {
    const rows = db.prepare("SELECT * FROM projects ORDER BY id DESC").all();
    res.json({ total: rows.length, projects: rows.map(p => projects.serialize(p, { withOwner: true })) });
  });

  app.get("/api/admin/audit", admin, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({
      entries: db.prepare("SELECT id, username, action, target, ip, createdAt FROM audit_logs ORDER BY id DESC LIMIT ?").all(limit)
    });
  });
};

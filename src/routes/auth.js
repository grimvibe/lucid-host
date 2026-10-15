const db = require("../database");
const config = require("../config");
const security = require("../security");

const USERNAME = /^[A-Za-z0-9_.-]{3,32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    maxProjects: user.maxProjects,
    memoryMB: user.memoryMB,
    createdAt: user.createdAt
  };
}

function passwordProblem(password) {
  if (typeof password !== "string") return "Password is required";
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 128) return "Password must be 128 characters or fewer";
  return null;
}

module.exports = function authRoutes(app) {
  // Lets the login screen know whether this is a first-run setup.
  app.get("/api/auth/status", (req, res) => {
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM users").get();
    res.json({ hasUsers: count > 0, registrationOpen: count === 0 || config.REGISTRATION_OPEN });
  });

  app.post("/api/auth/register", async (req, res) => {
    const { username, email, password } = req.body || {};
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM users").get();

    if (count > 0 && !config.REGISTRATION_OPEN) {
      return res.status(403).json({ error: "Registration is closed" });
    }
    if (security.rateLimited(`register:${req.ip}`, 5, 3600000)) {
      return res.status(429).json({ error: "Too many sign-ups from this address. Try again later." });
    }
    if (typeof username !== "string" || !USERNAME.test(username)) {
      return res.status(400).json({ error: "Username must be 3-32 characters (letters, numbers, . _ -)" });
    }
    if (typeof email !== "string" || !EMAIL.test(email) || email.length > 120) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });

    const exists = db.prepare("SELECT 1 FROM users WHERE username = ? OR email = ?").get(username, email);
    if (exists) return res.status(409).json({ error: "That username or email is already registered" });

    const passwordHash = await security.hashPassword(password);
    const role = count === 0 ? "admin" : "user";

    const result = db.prepare(`
      INSERT INTO users (username, email, passwordHash, role, maxProjects, memoryMB, createdAt, lastLoginAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(username, email.trim(), passwordHash, role,
      config.DEFAULT_MAX_PROJECTS, config.DEFAULT_MEMORY_MB,
      new Date().toISOString(), new Date().toISOString());

    const userId = Number(result.lastInsertRowid);

    // Projects created before accounts existed go to the first admin.
    if (role === "admin") {
      db.prepare("UPDATE projects SET ownerId = ? WHERE ownerId IS NULL").run(userId);
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    security.setSessionCookie(res, security.createSession(userId, req.ip));
    req.user = user;
    security.audit(req, "auth.register", username);

    res.status(201).json({ user: publicUser(user) });
  });

  app.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body || {};

    if (typeof username !== "string" || typeof password !== "string" || password.length > 128) {
      return res.status(400).json({ error: "Username and password are required" });
    }
    if (security.rateLimited(`login:${req.ip}:${username.toLowerCase()}`, 8, 15 * 60000) ||
        security.rateLimited(`login-ip:${req.ip}`, 40, 15 * 60000)) {
      return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    }

    const user = db.prepare("SELECT * FROM users WHERE username = ? OR email = ?").get(username, username);

    if (!user) {
      await security.burnPasswordTime(password);
      return res.status(401).json({ error: "Incorrect username or password" });
    }
    if (!(await security.verifyPassword(password, user.passwordHash))) {
      req.user = user;
      security.audit(req, "auth.login_failed", user.username);
      return res.status(401).json({ error: "Incorrect username or password" });
    }
    if (user.suspended) {
      return res.status(403).json({ error: "This account has been suspended" });
    }

    db.prepare("UPDATE users SET lastLoginAt = ? WHERE id = ?").run(new Date().toISOString(), user.id);
    security.setSessionCookie(res, security.createSession(user.id, req.ip));
    req.user = user;
    security.audit(req, "auth.login", user.username);

    res.json({ user: publicUser(user) });
  });

  app.post("/api/auth/logout", (req, res) => {
    security.destroySession(req.sessionToken);
    security.clearSessionCookie(res);
    res.json({ message: "Signed out" });
  });

  app.get("/api/auth/me", security.requireAuth, (req, res) => {
    const { unread } = db.prepare(
      "SELECT COUNT(*) AS unread FROM notifications WHERE userId = ? AND read = 0"
    ).get(req.user.id);
    res.json({ user: publicUser(req.user), unreadNotifications: unread });
  });

  app.post("/api/auth/password", security.requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const problem = passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: problem });

    const row = db.prepare("SELECT passwordHash FROM users WHERE id = ?").get(req.user.id);
    if (typeof currentPassword !== "string" ||
        !(await security.verifyPassword(currentPassword, row.passwordHash))) {
      return res.status(403).json({ error: "Current password is incorrect" });
    }

    db.prepare("UPDATE users SET passwordHash = ? WHERE id = ?")
      .run(await security.hashPassword(newPassword), req.user.id);

    // Sign out every other device.
    security.destroyUserSessions(req.user.id, req.sessionToken);
    security.audit(req, "auth.password_changed", req.user.username);
    res.json({ message: "Password updated" });
  });
};

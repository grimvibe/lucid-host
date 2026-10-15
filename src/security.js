const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const db = require("./database");
const config = require("./config");

const scrypt = promisify(crypto.scrypt);

/* ---------- Passwords (scrypt, per-user salt) ---------- */

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Used to keep login timing similar when the user does not exist.
let dummyHash;
async function burnPasswordTime(password) {
  dummyHash = dummyHash || (await hashPassword("lucid-host-dummy"));
  await verifyPassword(password, dummyHash);
}

/* ---------- Secret key for encrypting env vars ---------- */

function loadSecretKey() {
  if (process.env.SECRET_KEY) {
    return crypto.createHash("sha256").update(process.env.SECRET_KEY).digest();
  }

  const file = path.join(config.DATA_DIR, ".secret");
  try {
    return Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  } catch {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString("hex"), { mode: 0o600 });
    return key;
  }
}

const SECRET_KEY = loadSecretKey();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SECRET_KEY, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString("base64")).join(".");
}

function decrypt(payload) {
  const [iv, tag, data] = String(payload).split(".").map(p => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", SECRET_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/* ---------- Sessions ---------- */

const COOKIE = "lucid_session";
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

function createSession(userId, ip) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(`
    INSERT INTO sessions (tokenHash, userId, createdAt, expiresAt, ip)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    sha256(token),
    userId,
    new Date(now).toISOString(),
    new Date(now + config.SESSION_DAYS * 86400000).toISOString(),
    ip || null
  );
  return token;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return out;
}

function setSessionCookie(res, token) {
  const maxAge = config.SESSION_DAYS * 86400;
  res.setHeader("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` +
    (config.COOKIE_SECURE ? "; Secure" : ""));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie",
    `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` +
    (config.COOKIE_SECURE ? "; Secure" : ""));
}

function tokenFromRequest(req) {
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

function destroySession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE tokenHash = ?").run(sha256(token));
}

function destroyUserSessions(userId, exceptToken) {
  if (exceptToken) {
    db.prepare("DELETE FROM sessions WHERE userId = ? AND tokenHash != ?")
      .run(userId, sha256(exceptToken));
  } else {
    db.prepare("DELETE FROM sessions WHERE userId = ?").run(userId);
  }
}

/* ---------- Middleware ---------- */

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; " +
    "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'self'");
  if (req.path && req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
}

// Blocks cross-site state-changing requests (on top of SameSite=Strict).
function originCheck(req, res, next) {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      let host = "";
      try { host = new URL(origin).host; } catch { /* invalid */ }
      if (host !== req.headers.host) {
        return res.status(403).json({ error: "Cross-site request blocked" });
      }
    }
  }
  next();
}

function loadUser(req, res, next) {
  const token = tokenFromRequest(req);
  req.sessionToken = token;
  req.user = null;

  if (token) {
    const row = db.prepare(`
      SELECT u.id, u.username, u.email, u.role, u.suspended, u.maxProjects,
             u.memoryMB, u.createdAt, s.expiresAt
      FROM sessions s JOIN users u ON u.id = s.userId
      WHERE s.tokenHash = ?
    `).get(sha256(token));

    if (row && new Date(row.expiresAt) > new Date() && !row.suspended) {
      req.user = row;
    } else if (row) {
      destroySession(token);
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in" });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in" });
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Administrator access required" });
  }
  next();
}

/* ---------- Rate limiting (in memory) ---------- */

const hits = new Map();

function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}

setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [key, list] of hits) {
    if (!list.length || list[list.length - 1] < cutoff) hits.delete(key);
  }
}, 600000).unref();

/* ---------- Audit log ---------- */

function audit(req, action, target) {
  db.prepare(`
    INSERT INTO audit_logs (userId, username, action, target, ip, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    req.user ? req.user.id : null,
    req.user ? req.user.username : null,
    action,
    target == null ? null : String(target).slice(0, 200),
    req.ip || null,
    new Date().toISOString()
  );
}

function notify(userId, type, message, projectId = null) {
  if (!userId) return;
  db.prepare(`
    INSERT INTO notifications (userId, type, message, projectId, read, createdAt)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(userId, type, message, projectId, new Date().toISOString());
}

module.exports = {
  hashPassword, verifyPassword, burnPasswordTime,
  encrypt, decrypt,
  createSession, setSessionCookie, clearSessionCookie, tokenFromRequest,
  destroySession, destroyUserSessions,
  securityHeaders, originCheck, loadUser, requireAuth, requireAdmin,
  rateLimited, audit, notify
};

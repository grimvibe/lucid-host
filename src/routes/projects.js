const express = require("express");
const fs = require("fs");
const db = require("../database");
const config = require("../config");
const security = require("../security");
const runner = require("../runner");
const deployer = require("../deploy");

const RUNTIMES = ["nodejs", "python"];
const PLATFORMS = ["whatsapp", "telegram", "discord", "other"];
const RESERVED_ENV = /^(PATH|HOME|NODE_OPTIONS|LD_.*|DYLD_.*)$/i;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cleanCommand(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 500 || /[\r\n\0]/.test(value)) {
    throw new HttpError(400, `${label} must be a single line of 500 characters or fewer`);
  }
  return value.trim() || null;
}

function validateFields(body, { partial = false } = {}) {
  const out = {};
  const { name, runtime, platform } = body;

  if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "Project name is required");
  if (name.trim().length > 60) throw new HttpError(400, "Project name must be 60 characters or fewer");
  out.name = name.trim();

  if (!RUNTIMES.includes(runtime)) throw new HttpError(400, "Runtime must be nodejs or python");
  out.runtime = runtime;

  if (!PLATFORMS.includes(platform)) throw new HttpError(400, "Invalid messaging platform");
  out.platform = platform;

  if ("installCommand" in body) out.installCommand = cleanCommand(body.installCommand, "Install command");
  if ("buildCommand" in body) out.buildCommand = cleanCommand(body.buildCommand, "Build command");
  if ("startCommand" in body) out.startCommand = cleanCommand(body.startCommand, "Start command");
  if ("autoRestart" in body) out.autoRestart = body.autoRestart ? 1 : 0;

  return out;
}

function codeFor(id) { return `#LCH-${String(id).padStart(3, "0")}`; }

function serialize(project, { withOwner = false } = {}) {
  const usage = runner.usageFor(project.id);
  const base = {
    id: project.id,
    code: codeFor(project.id),
    name: project.name,
    runtime: project.runtime,
    platform: project.platform,
    status: project.status,
    createdAt: project.createdAt,
    source: project.source,
    repoUrl: project.repoUrl,
    branch: project.branch,
    installCommand: project.installCommand,
    buildCommand: project.buildCommand,
    startCommand: project.startCommand,
    autoRestart: !!project.autoRestart,
    deployedAt: project.deployedAt,
    startedAt: project.startedAt,
    lastExitCode: project.lastExitCode,
    lastError: project.lastError,
    restarts: project.restarts,
    deployed: !!project.deployedAt || runner.hasCode(project.id),
    envCount: envKeys(project).length,
    cpu: usage.cpu,
    memoryMB: usage.memoryMB,
    memoryLimitMB: usage.limitMB,
    uptimeSeconds: usage.uptimeSeconds
  };
  if (withOwner) {
    const owner = db.prepare("SELECT username FROM users WHERE id = ?").get(project.ownerId);
    base.owner = owner ? owner.username : null;
    base.ownerId = project.ownerId;
  }
  return base;
}

function envObject(project) {
  if (!project.envEncrypted) return {};
  try { return JSON.parse(security.decrypt(project.envEncrypted)); } catch { return {}; }
}

function envKeys(project) { return Object.keys(envObject(project)); }

// Owners see their own projects; admins can reach every project.
function getAccessible(req, idParam) {
  const id = Number(idParam);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, "Invalid project ID");

  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!project || (project.ownerId !== req.user.id && req.user.role !== "admin")) {
    throw new HttpError(404, "Project not found");
  }
  return project;
}

function wipeProjectFiles(id) {
  fs.rmSync(runner.dirsFor(id).root, { recursive: true, force: true });
  runner.clearLogs(id);
}

module.exports = function projectRoutes(app) {
  const auth = security.requireAuth;

  app.get("/api/projects", auth, (req, res) => {
    const rows = db.prepare("SELECT * FROM projects WHERE ownerId = ? ORDER BY id DESC").all(req.user.id);
    res.json({ total: rows.length, projects: rows.map(p => serialize(p)) });
  });

  app.post("/api/projects", auth, (req, res) => {
    const fields = validateFields(req.body || {});

    if (req.user.role !== "admin") {
      const { count } = db.prepare("SELECT COUNT(*) AS count FROM projects WHERE ownerId = ?").get(req.user.id);
      if (count >= req.user.maxProjects) {
        throw new HttpError(403, `Your plan allows ${req.user.maxProjects} projects. Delete one or ask an admin to raise your limit.`);
      }
    }

    const result = db.prepare(`
      INSERT INTO projects (name, runtime, platform, status, createdAt, ownerId,
                            installCommand, buildCommand, startCommand, autoRestart)
      VALUES (?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?)
    `).run(fields.name, fields.runtime, fields.platform, new Date().toISOString(), req.user.id,
      fields.installCommand ?? null, fields.buildCommand ?? null, fields.startCommand ?? null,
      fields.autoRestart ?? 1);

    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(result.lastInsertRowid);
    security.audit(req, "project.create", project.name);
    res.status(201).json({ message: "Project created", project: serialize(project) });
  });

  app.get("/api/projects/:id", auth, (req, res) => {
    res.json(serialize(getAccessible(req, req.params.id), { withOwner: req.user.role === "admin" }));
  });

  app.put("/api/projects/:id", auth, (req, res) => {
    const project = getAccessible(req, req.params.id);
    const f = validateFields(req.body || {});
    const merged = { ...project, ...f };

    db.prepare(`
      UPDATE projects SET name = ?, runtime = ?, platform = ?, installCommand = ?,
        buildCommand = ?, startCommand = ?, autoRestart = ? WHERE id = ?
    `).run(merged.name, merged.runtime, merged.platform, merged.installCommand,
      merged.buildCommand, merged.startCommand, merged.autoRestart, project.id);

    security.audit(req, "project.update", project.name);
    res.json({
      message: "Project updated",
      project: serialize(db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id))
    });
  });

  app.delete("/api/projects/:id", auth, async (req, res) => {
    const project = getAccessible(req, req.params.id);
    if (deployer.isDeploying(project.id)) throw new HttpError(409, "Wait for the deployment to finish first");

    await runner.stop(project.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    wipeProjectFiles(project.id);

    security.audit(req, "project.delete", project.name);
    res.json({ message: "Project deleted", id: project.id });
  });

  /* ----- Process controls ----- */

  async function control(req, res, action) {
    const project = getAccessible(req, req.params.id);
    try {
      if (action === "start") await runner.start(project.id);
      else if (action === "stop") await runner.stop(project.id);
      else await runner.restart(project.id);
    } catch (error) {
      throw new HttpError(error.status || 500, error.message);
    }
    security.audit(req, `project.${action}`, project.name);
    res.json({
      message: `Project ${action === "stop" ? "stopped" : action === "start" ? "started" : "restarted"}`,
      project: serialize(db.prepare("SELECT * FROM projects WHERE id = ?").get(project.id))
    });
  }

  app.post("/api/projects/:id/start", auth, (req, res) => control(req, res, "start"));
  app.post("/api/projects/:id/stop", auth, (req, res) => control(req, res, "stop"));
  app.post("/api/projects/:id/restart", auth, (req, res) => control(req, res, "restart"));

  /* ----- Deployment ----- */

  function deployLimit(req) {
    if (security.rateLimited(`deploy:${req.user.id}`, 10, 10 * 60000)) {
      throw new HttpError(429, "Too many deployments. Try again in a few minutes.");
    }
  }

  // Deployments can take minutes, so respond right away; progress shows in the logs.
  function runDeploy(req, res, project, source) {
    if (deployer.isDeploying(project.id)) throw new HttpError(409, "A deployment is already in progress");
    deployLimit(req);
    security.audit(req, "project.deploy", `${project.name} (${source.type})`);

    deployer.deploy(project.id, source, { autoStart: req.query.autoStart !== "false" })
      .catch(() => { /* already logged and notified */ });

    res.status(202).json({ message: "Deployment started" });
  }

  app.post("/api/projects/:id/deploy", auth, (req, res) => {
    const project = getAccessible(req, req.params.id);
    const body = req.body || {};
    const repoUrl = body.repoUrl || project.repoUrl;
    if (!repoUrl) throw new HttpError(400, "Enter a Git repository URL");

    runDeploy(req, res, project, {
      type: "git",
      repoUrl,
      branch: body.branch === undefined ? project.branch : body.branch || null,
      token: typeof body.token === "string" && body.token ? body.token.slice(0, 300) : null
    });
  });

  app.post("/api/projects/:id/upload",
    auth,
    express.raw({
      type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
      limit: config.MAX_UPLOAD
    }),
    (req, res) => {
      const project = getAccessible(req, req.params.id);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new HttpError(400, "Upload a .zip file");
      }
      runDeploy(req, res, project, { type: "zip", buffer: req.body });
    });

  /* ----- Environment variables (encrypted at rest, never sent back) ----- */

  app.get("/api/projects/:id/env", auth, (req, res) => {
    const project = getAccessible(req, req.params.id);
    res.json({ env: envKeys(project).map(key => ({ key, hasValue: true })) });
  });

  app.put("/api/projects/:id/env", auth, (req, res) => {
    const project = getAccessible(req, req.params.id);
    const list = (req.body || {}).env;
    if (!Array.isArray(list) || list.length > 50) throw new HttpError(400, "Provide up to 50 variables");

    const existing = envObject(project);
    const next = {};

    for (const item of list) {
      const key = item && typeof item.key === "string" ? item.key.trim() : "";
      if (!ENV_KEY.test(key)) throw new HttpError(400, `Invalid variable name: ${key || "(empty)"}`);
      if (RESERVED_ENV.test(key)) throw new HttpError(400, `${key} is reserved and cannot be set`);

      if (item.value === null || item.value === undefined) {
        if (key in existing) next[key] = existing[key]; // keep the stored value
        else throw new HttpError(400, `Enter a value for ${key}`);
      } else if (typeof item.value === "string" && item.value.length <= 4000) {
        next[key] = item.value;
      } else {
        throw new HttpError(400, `Value for ${key} is too long`);
      }
    }

    db.prepare("UPDATE projects SET envEncrypted = ? WHERE id = ?")
      .run(Object.keys(next).length ? security.encrypt(JSON.stringify(next)) : null, project.id);

    security.audit(req, "project.env_update", project.name);
    res.json({
      message: "Environment variables saved. Restart the project to apply them.",
      env: Object.keys(next).map(key => ({ key, hasValue: true }))
    });
  });

  /* ----- Logs ----- */

  app.get("/api/projects/:id/logs", auth, (req, res) => {
    const project = getAccessible(req, req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), config.MAX_LOG_LINES);
    res.json({ lines: runner.getLogs(project.id, limit) });
  });

  app.delete("/api/projects/:id/logs", auth, (req, res) => {
    const project = getAccessible(req, req.params.id);
    runner.clearLogs(project.id);
    res.json({ message: "Logs cleared" });
  });

  // Server-sent events: new log lines appear instantly.
  app.get("/api/projects/:id/logs/stream", auth, (req, res) => {
    const project = getAccessible(req, req.params.id);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 3000\n\n");

    const unsubscribe = runner.subscribe(project.id, entry => res.write(`data: ${JSON.stringify(entry)}\n\n`));
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);

    req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });
};

module.exports.serialize = serialize;
module.exports.wipeProjectFiles = wipeProjectFiles;
module.exports.HttpError = HttpError;

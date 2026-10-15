// Hosting engine: starts, stops, restarts and monitors bot processes.
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const db = require("./database");
const security = require("./security");
const metrics = require("./metrics");

const isWindows = process.platform === "win32";
const running = new Map();  // projectId -> live process state
const restartState = new Map(); // projectId -> { times: [], timer }
const logBuffers = new Map();   // projectId -> { lines: [], appended: 0, loaded: bool }
const subscribers = new Map();  // projectId -> Set<fn>

fs.mkdirSync(config.PROJECTS_DIR, { recursive: true });
fs.mkdirSync(config.LOGS_DIR, { recursive: true });

/* ---------- Paths ---------- */

function dirsFor(id) {
  const root = path.join(config.PROJECTS_DIR, String(Number(id)));
  return {
    root,
    app: path.join(root, "app"),
    home: path.join(root, "home"),
    tmp: path.join(root, "tmp")
  };
}

function ensureDirs(id) {
  const d = dirsFor(id);
  for (const dir of [d.root, d.home, d.tmp]) fs.mkdirSync(dir, { recursive: true });
  return d;
}

function hasCode(id) {
  try { return fs.readdirSync(dirsFor(id).app).length > 0; } catch { return false; }
}

/* ---------- Logs ---------- */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const logFile = id => path.join(config.LOGS_DIR, `${Number(id)}.log`);

function bufferFor(id) {
  let buffer = logBuffers.get(id);
  if (!buffer) {
    buffer = { lines: [], appended: 0 };
    logBuffers.set(id, buffer);
    try {
      const stat = fs.statSync(logFile(id));
      const fd = fs.openSync(logFile(id), "r");
      const size = Math.min(stat.size, 200 * 1024);
      const chunk = Buffer.alloc(size);
      fs.readSync(fd, chunk, 0, size, stat.size - size);
      fs.closeSync(fd);
      for (const line of chunk.toString("utf8").split("\n").slice(1)) {
        try { buffer.lines.push(JSON.parse(line)); } catch { /* partial line */ }
      }
      buffer.lines = buffer.lines.slice(-config.MAX_LOG_LINES);
    } catch { /* no log yet */ }
  }
  return buffer;
}

function log(id, stream, message) {
  const entry = {
    t: new Date().toISOString(),
    s: stream, // "out" | "err" | "sys"
    m: String(message).replace(ANSI, "").slice(0, 2000)
  };

  const buffer = bufferFor(id);
  buffer.lines.push(entry);
  if (buffer.lines.length > config.MAX_LOG_LINES) buffer.lines.shift();

  try {
    if (++buffer.appended % 200 === 0 && fs.statSync(logFile(id)).size > 2 * 1024 * 1024) {
      fs.renameSync(logFile(id), logFile(id) + ".1");
    }
    fs.appendFileSync(logFile(id), JSON.stringify(entry) + "\n");
  } catch { /* logging must never crash the host */ }

  for (const fn of subscribers.get(id) || []) {
    try { fn(entry); } catch { /* ignore broken listener */ }
  }
}

function getLogs(id, limit = 200) {
  return bufferFor(id).lines.slice(-limit);
}

function clearLogs(id) {
  bufferFor(id).lines = [];
  try { fs.rmSync(logFile(id), { force: true }); } catch { /* ignore */ }
}

function subscribe(id, fn) {
  if (!subscribers.has(id)) subscribers.set(id, new Set());
  subscribers.get(id).add(fn);
  return () => subscribers.get(id)?.delete(fn);
}

function pipeStream(id, stream, kind) {
  let partial = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    partial += chunk;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop();
    if (partial.length > 8000) { lines.push(partial); partial = ""; }
    for (const line of lines) if (line.trim()) log(id, kind, line);
  });
  stream.on("end", () => { if (partial.trim()) log(id, kind, partial); });
}

/* ---------- Project / environment helpers ---------- */

function getProject(id) {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(Number(id));
}

function memoryLimitFor(project) {
  const owner = project.ownerId
    ? db.prepare("SELECT memoryMB FROM users WHERE id = ?").get(project.ownerId)
    : null;
  return (owner && owner.memoryMB) || config.DEFAULT_MEMORY_MB;
}

function userEnv(project) {
  if (!project.envEncrypted) return {};
  try { return JSON.parse(security.decrypt(project.envEncrypted)); } catch { return {}; }
}

function venvBin(appDir, name) {
  return path.join(appDir, ".venv", isWindows ? "Scripts" : "bin", name + (isWindows ? ".exe" : ""));
}

// Environment given to bots. The platform's own secrets are never passed on.
function buildEnv(project, { forStart }) {
  const d = dirsFor(project.id);
  const env = {
    PATH: process.env.PATH,
    HOME: d.home,
    USERPROFILE: d.home,
    TMPDIR: d.tmp,
    TEMP: d.tmp,
    TMP: d.tmp,
    LANG: process.env.LANG || "C.UTF-8",
    NODE_ENV: "production",
    PYTHONUNBUFFERED: "1",
    PORT: String(20000 + (project.id % 40000)),
    LUCID_PROJECT_ID: String(project.id)
  };
  if (isWindows) env.SystemRoot = process.env.SystemRoot;

  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;

  if (fs.existsSync(path.join(d.app, ".venv"))) {
    env.VIRTUAL_ENV = path.join(d.app, ".venv");
    env.PATH = path.dirname(venvBin(d.app, "python")) + path.delimiter + env.PATH;
  }

  if (forStart && project.runtime === "nodejs") {
    const mb = memoryLimitFor(project);
    if (mb >= 64) env.NODE_OPTIONS = `--max-old-space-size=${Math.floor(mb * 0.8)}`;
  }

  return { ...env, ...userEnv(project) };
}

function dockerArgs(project, cmd, env, { name, network = true }) {
  const d = dirsFor(project.id);
  const image = project.runtime === "python" ? config.DOCKER_PYTHON_IMAGE : config.DOCKER_NODE_IMAGE;
  const args = [
    "run", "--rm",
    "--name", name,
    "--memory", `${memoryLimitFor(project)}m`,
    "--cpus", "1",
    "--pids-limit", "512",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "-v", `${d.app}:/app`,
    "-w", "/app",
    "-e", "HOME=/tmp"
  ];
  if (!network) args.push("--network", "none");
  if (process.getuid) args.push("--user", `${process.getuid()}:${process.getgid()}`);

  // Values come from the client process environment, so secrets stay out of argv.
  const skip = new Set(["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot",
    "DOCKER_HOST", "VIRTUAL_ENV"]);
  for (const key of Object.keys(env)) if (!skip.has(key)) args.push("-e", key);

  args.push(image, "sh", "-c", cmd);
  return args;
}

// Turns a shell command into something we can spawn, per runner mode.
function specFor(project, cmd, { forStart, name }) {
  const env = buildEnv(project, { forStart });
  const d = dirsFor(project.id);

  if (config.RUNNER === "docker") {
    return {
      file: "docker",
      args: dockerArgs(project, cmd, env, { name }),
      options: { env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, HOME: process.env.HOME, ...env } }
    };
  }
  if (isWindows) {
    return { file: cmd, args: [], options: { cwd: d.app, env, shell: true, windowsHide: true } };
  }
  return { file: "sh", args: ["-c", cmd], options: { cwd: d.app, env, detached: true } };
}

/* ---------- Killing ---------- */

function killTree(child, signal, containerName) {
  if (config.RUNNER === "docker") {
    execFile("docker", ["stop", "-t", "5", containerName], () => {});
    return;
  }
  try {
    if (isWindows) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
    else process.kill(-child.pid, signal);
  } catch { /* already gone */ }
}

/* ---------- Status persistence ---------- */

function update(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE projects SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map(k => fields[k]), Number(id));
}

/* ---------- Start / stop / restart ---------- */

function resolveStartCommand(project) {
  if (project.startCommand) return project.startCommand;
  const { app } = dirsFor(project.id);
  const has = f => fs.existsSync(path.join(app, f));

  if (project.runtime === "nodejs") {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
      if (pkg.scripts && pkg.scripts.start) return "npm start";
      if (pkg.main && has(pkg.main) && /^[\w./-]+$/.test(pkg.main)) return `node ${pkg.main}`;
    } catch { /* no package.json */ }
    const file = ["index.js", "bot.js", "main.js", "app.js", "server.js"].find(has);
    return file ? `node ${file}` : null;
  }

  const file = ["main.py", "bot.py", "app.py", "run.py", "index.py"].find(has);
  if (!file) return null;
  const python = fs.existsSync(path.join(app, ".venv"))
    ? `"${venvBin(app, "python")}"` : (isWindows ? "python" : "python3");
  return `${python} -u ${file}`;
}

function startedBy(id) {
  return running.has(id);
}

async function start(id, { fromRestart = false } = {}) {
  id = Number(id);
  const project = getProject(id);
  if (!project) throw Object.assign(new Error("Project not found"), { status: 404 });
  if (running.has(id)) return;
  if (project.status === "deploying") {
    throw Object.assign(new Error("Project is being deployed"), { status: 409 });
  }
  if (!hasCode(id)) {
    throw Object.assign(new Error("Deploy your code before starting this project"), { status: 400 });
  }

  const cmd = resolveStartCommand(project);
  if (!cmd) {
    throw Object.assign(new Error(
      "No start command found. Set a start command in the project settings."), { status: 400 });
  }

  ensureDirs(id);
  const name = `lucid-${id}`;
  const spec = specFor(project, cmd, { forStart: true, name });

  if (!fromRestart) {
    const info = restartState.get(id);
    if (info) { clearTimeout(info.timer); restartState.delete(id); }
  }

  log(id, "sys", `Starting: ${cmd}`);

  await new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, { ...spec.options, stdio: ["ignore", "pipe", "pipe"] });
    const state = {
      child, name, stopping: false, startedAt: Date.now(),
      cpu: 0, memoryMB: 0, limitMB: memoryLimitFor(project), oom: false
    };

    child.once("error", error => {
      running.delete(id);
      log(id, "sys", `Failed to start: ${error.message}`);
      update(id, { status: "error", lastError: `Failed to start: ${error.message}`, desiredState: "stopped" });
      reject(error);
    });

    child.once("spawn", () => {
      running.set(id, state);
      pipeStream(id, child.stdout, "out");
      pipeStream(id, child.stderr, "err");
      update(id, {
        status: "running", desiredState: "running", lastError: null,
        startedAt: new Date().toISOString()
      });
      log(id, "sys", `Process started (pid ${child.pid})`);
      ensureMonitor();
      resolve();
    });

    child.on("exit", (code, signal) => onExit(id, state, code, signal));
  });
}

function onExit(id, state, code, signal) {
  if (running.get(id) === state) running.delete(id);
  const project = getProject(id);
  if (!project) return;

  const why = signal ? `signal ${signal}` : `code ${code}`;
  log(id, "sys", `Process exited with ${why}`);

  if (state.stopping) {
    update(id, { status: "stopped", startedAt: null, lastExitCode: code });
    return;
  }

  if (state.oom) {
    update(id, {
      status: "error", desiredState: "stopped", startedAt: null, lastExitCode: code,
      lastError: `Stopped: exceeded the ${state.limitMB} MB memory limit`
    });
    security.notify(project.ownerId, "error",
      `${project.name} was stopped because it used more than ${state.limitMB} MB of memory.`, id);
    return;
  }

  if (code === 0) {
    update(id, { status: "stopped", desiredState: "stopped", startedAt: null, lastExitCode: 0 });
    return;
  }

  handleCrash(project, code, why);
}

function handleCrash(project, code, why) {
  const id = project.id;
  const info = restartState.get(id) || { times: [], timer: null };
  const now = Date.now();
  info.times = info.times.filter(t => now - t < 10 * 60 * 1000);
  info.times.push(now);
  restartState.set(id, info);

  update(id, {
    status: "error", startedAt: null, lastExitCode: code,
    restarts: project.restarts + 1,
    lastError: `Crashed (${why})`
  });

  if (!project.autoRestart || info.times.length > 5) {
    update(id, {
      desiredState: "stopped",
      lastError: project.autoRestart
        ? `Crashed repeatedly (${why}); auto-restart gave up`
        : `Crashed (${why})`
    });
    log(id, "sys", project.autoRestart
      ? "Crashed too many times in 10 minutes. Auto-restart disabled until you start it again."
      : "Crashed. Auto-restart is turned off for this project.");
    security.notify(project.ownerId, "error", `${project.name} crashed (${why}).`, id);
    return;
  }

  const delay = Math.min(30000, 1000 * 2 ** (info.times.length - 1));
  log(id, "sys", `Crashed (${why}). Restarting in ${Math.round(delay / 1000)}s (attempt ${info.times.length}/5)`);
  if (info.times.length === 1) {
    security.notify(project.ownerId, "warning", `${project.name} crashed and is restarting automatically.`, id);
  }

  info.timer = setTimeout(() => {
    start(id, { fromRestart: true }).catch(error => log(id, "sys", `Restart failed: ${error.message}`));
  }, delay);
  info.timer.unref?.();
}

function stop(id, { keepDesired = false } = {}) {
  id = Number(id);
  const info = restartState.get(id);
  if (info) { clearTimeout(info.timer); restartState.delete(id); }

  const state = running.get(id);
  if (!state) {
    const project = getProject(id);
    if (project && !keepDesired) {
      update(id, {
        desiredState: "stopped",
        ...(["running", "error"].includes(project.status) ? { status: "stopped", startedAt: null } : {})
      });
    }
    return Promise.resolve();
  }

  return new Promise(resolve => {
    state.stopping = true;
    if (!keepDesired) update(id, { desiredState: "stopped" });
    log(id, "sys", "Stopping...");

    const force = setTimeout(() => killTree(state.child, "SIGKILL", state.name), 5000);
    state.child.once("exit", () => { clearTimeout(force); resolve(); });
    killTree(state.child, "SIGTERM", state.name);
  });
}

async function restart(id) {
  await stop(id);
  await start(id);
}

async function stopAll() {
  await Promise.all([...running.keys()].map(id => stop(id, { keepDesired: true })));
}

// After a host restart, bring back every project that was running.
async function restoreAll() {
  db.prepare("UPDATE projects SET status = 'stopped', startedAt = NULL WHERE status IN ('running', 'deploying')").run();
  db.prepare("UPDATE projects SET status = 'stopped' WHERE status = 'error' AND desiredState = 'running'").run();

  const toStart = db.prepare("SELECT id FROM projects WHERE desiredState = 'running'").all();
  for (const { id } of toStart) {
    try { await start(id); } catch (error) { log(id, "sys", `Auto-start failed: ${error.message}`); }
    await new Promise(r => setTimeout(r, 500));
  }
}

/* ---------- Run a one-off command (install / build) ---------- */

function runCommand(id, cmd, { timeoutMs = config.INSTALL_TIMEOUT_MS, label } = {}) {
  const project = getProject(id);
  ensureDirs(id);
  const name = `lucid-${id}-job`;
  const spec = specFor(project, cmd, { forStart: false, name });
  return execSpec(id, spec, { timeoutMs, label: label || cmd, name });
}

function execSpec(id, spec, { timeoutMs, label, name }) {
  return new Promise(resolve => {
    log(id, "sys", `$ ${label}`);
    const child = spawn(spec.file, spec.args, { ...spec.options, stdio: ["ignore", "pipe", "pipe"] });
    let finished = false;

    const timer = setTimeout(() => {
      log(id, "sys", `Command timed out after ${Math.round(timeoutMs / 1000)}s`);
      killTree(child, "SIGKILL", name);
      if (config.RUNNER === "docker") execFile("docker", ["rm", "-f", name], () => {});
    }, timeoutMs);

    pipeStream(id, child.stdout, "out");
    pipeStream(id, child.stderr, "out");

    const done = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(code);
    };
    child.once("error", error => { log(id, "sys", error.message); done(-1); });
    child.once("close", code => done(code === null ? -1 : code));
  });
}

/* ---------- Monitoring ---------- */

let monitor = null;

function ensureMonitor() {
  if (monitor) return;
  monitor = setInterval(tick, 2000);
  monitor.unref();
}

async function dockerStats() {
  return new Promise(resolve => {
    execFile("docker", ["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}"],
      { timeout: 8000 }, (err, out) => {
        const map = new Map();
        if (!err) {
          for (const line of out.split("\n")) {
            const [name, cpu, mem] = line.split("|");
            if (!name || !mem) continue;
            const match = /([\d.]+)\s*([KMG]i?B)/i.exec(mem);
            const factor = match ? { k: 1 / 1024, m: 1, g: 1024 }[match[2][0].toLowerCase()] : 0;
            map.set(name, { cpu: parseFloat(cpu) || 0, memoryMB: match ? Math.round(parseFloat(match[1]) * factor) : 0 });
          }
        }
        resolve(map);
      });
  });
}

async function tick() {
  if (running.size === 0) { clearInterval(monitor); monitor = null; return; }

  let docker = null;
  if (config.RUNNER === "docker") docker = await dockerStats();
  else await metrics.refreshProcessTable();

  for (const [id, state] of running) {
    const usage = docker
      ? (docker.get(state.name) || { cpu: 0, memoryMB: 0 })
      : metrics.usageForTree(state.child.pid);

    state.cpu = usage.cpu;
    state.memoryMB = usage.memoryMB;

    // Process mode enforces the memory limit here; Docker enforces it itself.
    if (!docker && !state.stopping && usage.memoryMB > state.limitMB) {
      state.oom = true;
      state.stopping = false;
      log(id, "sys", `Memory limit exceeded (${usage.memoryMB} MB > ${state.limitMB} MB). Stopping.`);
      killTree(state.child, "SIGKILL", state.name);
    }
  }
}

function usageFor(id) {
  const state = running.get(Number(id));
  if (!state) return { running: false, cpu: 0, memoryMB: 0, uptimeSeconds: 0, limitMB: null };
  return {
    running: true,
    cpu: state.cpu,
    memoryMB: state.memoryMB,
    uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
    limitMB: state.limitMB
  };
}

module.exports = {
  dirsFor, ensureDirs, hasCode, resolveStartCommand, venvBin,
  start, stop, restart, stopAll, restoreAll, runCommand, execSpec,
  usageFor, startedBy, running: id => running.has(Number(id)),
  log, getLogs, clearLogs, subscribe, buildEnv
};

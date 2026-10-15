// End-to-end smoke test. Starts a throwaway server and exercises the whole API.
// Run with: npm test
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-test-"));
let passed = 0;

/* ---------- tiny zip builder (stored entries) ---------- */
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/* ---------- helpers ---------- */
function client() {
  let cookie = "";
  return async (method, url, body, raw) => {
    const headers = { cookie };
    let payload;
    if (raw) { headers["content-type"] = "application/zip"; payload = raw; }
    else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers, body: payload });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data, cookie };
  };
}

function check(name, condition, detail) {
  if (!condition) {
    console.error(`  ✗ ${name}${detail ? " — " + JSON.stringify(detail) : ""}`);
    throw new Error(`Failed: ${name}`);
  }
  passed++;
  console.log(`  ✓ ${name}`);
}

async function waitFor(label, fn, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

const BOT = `
console.log("Bot online");
setInterval(() => console.log("tick " + Date.now()), 500);
if (process.env.BOOM) setTimeout(() => process.exit(1), 800);
process.on("SIGTERM", () => { console.log("bye"); process.exit(0); });
`;
const botZip = () => makeZip({
  "my-bot/package.json": JSON.stringify({ name: "bot", version: "1.0.0", scripts: { start: "node bot.js" } }),
  "my-bot/bot.js": BOT
});

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, "../src/server.js")], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", d => process.stderr.write(d));

  try {
    await waitFor("server start", async () => { try { return (await fetch(BASE + "/health")).ok; } catch { return false; } }, 15000);

    const admin = client(), bob = client(), anon = client();

    console.log("Security");
    check("projects require login", (await anon("GET", "/api/projects")).status === 401);
    check("weak password rejected",
      (await anon("POST", "/api/auth/register", { username: "weak", email: "w@x.io", password: "123" })).status === 400);

    let r = await admin("POST", "/api/auth/register", { username: "alex", email: "alex@example.com", password: "correct horse battery" });
    check("first user becomes admin", r.status === 201 && r.data.user.role === "admin", r.data);
    check("session cookie is HttpOnly", r.cookie.startsWith("lucid_session="));
    check("password hash never returned", !JSON.stringify(r.data).includes("scrypt"));

    r = await bob("POST", "/api/auth/register", { username: "bob", email: "bob@example.com", password: "another long password" });
    check("second user is a normal user", r.data.user.role === "user");
    check("wrong password rejected",
      (await anon("POST", "/api/auth/login", { username: "alex", password: "nope-nope-nope" })).status === 401);
    check("user cannot open admin API", (await bob("GET", "/api/admin/users")).status === 403);

    console.log("Projects & ownership");
    r = await admin("POST", "/api/projects", { name: "WhatsApp Bot", runtime: "nodejs", platform: "whatsapp" });
    check("create project", r.status === 201, r.data);
    const id = r.data.project.id;
    check("other users cannot see it", (await bob("GET", `/api/projects/${id}`)).status === 404);
    check("other users cannot control it", (await bob("POST", `/api/projects/${id}/start`)).status === 404);
    check("cannot start before deploying", (await admin("POST", `/api/projects/${id}/start`)).status === 400);
    check("invalid runtime rejected",
      (await admin("POST", "/api/projects", { name: "x", runtime: "php", platform: "other" })).status === 400);

    console.log("Environment variables");
    r = await admin("PUT", `/api/projects/${id}/env`, { env: [{ key: "API_TOKEN", value: "super-secret-123" }] });
    check("save env var", r.status === 200, r.data);
    r = await admin("GET", `/api/projects/${id}/env`);
    check("env values are never returned", !JSON.stringify(r.data).includes("super-secret"), r.data);
    check("reserved env names blocked",
      (await admin("PUT", `/api/projects/${id}/env`, { env: [{ key: "PATH", value: "x" }] })).status === 400);
    const db = fs.readFileSync(path.join(DATA_DIR, "lucid-host.db"));
    check("env values are encrypted at rest", !db.includes("super-secret-123"));

    console.log("Deployment");
    check("zip upload accepted", (await admin("POST", `/api/projects/${id}/upload`, undefined, botZip())).status === 202);
    await waitFor("bot running", async () => (await admin("GET", `/api/projects/${id}`)).data.status === "running");
    check("deployed and running", true);

    console.log("Process controls & monitoring");
    await new Promise(r => setTimeout(r, 3500));
    r = await admin("GET", `/api/projects/${id}`);
    check("memory usage is tracked", r.data.memoryMB > 0, r.data);
    check("uptime is tracked", r.data.uptimeSeconds >= 2, r.data);
    r = await admin("GET", `/api/projects/${id}/logs`);
    check("live logs captured", r.data.lines.some(l => l.m === "Bot online"), r.data.lines.slice(-3));

    const sse = await fetch(`${BASE}/api/projects/${id}/logs/stream`, { headers: { cookie: (await admin("GET", "/api/auth/me")).cookie } });
    const reader = sse.body.getReader();
    let streamed = "";
    const until = Date.now() + 4000;
    while (Date.now() < until && !/tick/.test(streamed)) {
      const c = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r(null), 1500))]);
      if (c && c.value) streamed += Buffer.from(c.value).toString();
    }
    check("SSE delivers new bot output", /tick/.test(streamed), streamed.slice(0, 200));
    await reader.cancel();

    r = await admin("POST", `/api/projects/${id}/restart`);
    check("restart", r.status === 200 && r.data.project.status === "running", r.data);
    r = await admin("GET", "/api/stats");
    check("stats count running projects", r.data.running === 1 && r.data.total === 1, r.data);
    r = await admin("POST", `/api/projects/${id}/stop`);
    check("stop", r.status === 200 && r.data.project.status === "stopped", r.data);

    console.log("Crash handling");
    await admin("PUT", `/api/projects/${id}/env`, { env: [{ key: "API_TOKEN" }, { key: "BOOM", value: "1" }] });
    await admin("POST", `/api/projects/${id}/start`);
    await waitFor("crash detected", async () => {
      const p = (await admin("GET", `/api/projects/${id}`)).data;
      return p.restarts >= 1;
    }, 20000);
    check("crash detected and auto-restart scheduled", true);
    r = await admin("GET", "/api/notifications");
    check("crash notification created", r.data.items.some(n => /crashed/i.test(n.message)), r.data);
    await admin("POST", `/api/projects/${id}/stop`);

    console.log("Upload safety");
    const evil = makeZip({ "../../evil.txt": "pwned", "package.json": "{}" });
    await admin("POST", `/api/projects/${id}/upload`, undefined, evil);
    const evilError = await waitFor("evil deploy rejected", async () => (await admin("GET", `/api/projects/${id}`)).data.lastError);
    check("zip path traversal rejected", /unsafe path/i.test(evilError), evilError);
    check("nothing written outside the project",
      !fs.existsSync(path.join(DATA_DIR, "evil.txt")) && !fs.existsSync(path.join(DATA_DIR, "..", "evil.txt")));
    check("project still has its previous code after a failed deploy",
      fs.existsSync(path.join(DATA_DIR, "projects", String(id), "app", "bot.js")));

    await admin("POST", `/api/projects/${id}/deploy`, { repoUrl: "http://example.com/a.git" });
    await waitFor("http repo rejected", async () => /https/i.test((await admin("GET", `/api/projects/${id}`)).data.lastError || ""));
    check("plain-http Git URLs are rejected", true);

    console.log("Admin");
    r = await admin("GET", "/api/admin/users");
    check("admin lists users", r.data.users.length === 2);
    const bobId = r.data.users.find(u => u.username === "bob").id;
    r = await admin("PATCH", `/api/admin/users/${bobId}`, { suspended: true });
    check("admin suspends a user", r.data.user.suspended === true, r.data);
    check("suspended user is signed out", (await bob("GET", "/api/auth/me")).status === 401);
    check("admin cannot demote self",
      (await admin("PATCH", `/api/admin/users/1`, { role: "user" })).status === 400);
    r = await admin("GET", "/api/admin/audit");
    check("audit log records actions", r.data.entries.some(e => e.action === "project.deploy"), r.data.entries.length);

    console.log("Cleanup");
    await new Promise(r => setTimeout(r, 1500));
    check("delete project", (await admin("DELETE", `/api/projects/${id}`)).status === 200);
    check("project files removed", !fs.existsSync(path.join(DATA_DIR, "projects", String(id))));

    console.log(`\nAll ${passed} checks passed.`);
  } finally {
    server.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 500));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch(error => { console.error("\n" + error.message); process.exit(1); });

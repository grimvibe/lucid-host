const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { DATA_DIR } = require("./config");

/* ---------- Per-process CPU / memory ---------- */

const isLinux = process.platform === "linux";
const TICKS = 100; // clock ticks per second on Linux
let previous = new Map(); // pid -> { ticks, at }
let table = new Map();    // pid -> { ppid, cpu, rssMB }

function readLinuxTable() {
  const now = Date.now();
  const next = new Map();
  const result = new Map();

  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(fields[1]);
      const ticks = Number(fields[11]) + Number(fields[12]);
      const rssMB = (Number(fields[21]) * 4096) / 1048576;
      const pid = Number(entry);

      const before = previous.get(pid);
      let cpu = 0;
      if (before && now > before.at) {
        cpu = ((ticks - before.ticks) / TICKS) / ((now - before.at) / 1000) * 100;
      }
      next.set(pid, { ticks, at: now });
      result.set(pid, { ppid, cpu: Math.max(0, cpu), rssMB });
    } catch { /* process exited */ }
  }
  previous = next;
  return Promise.resolve(result);
}

function readPsTable() {
  return new Promise(resolve => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,pcpu=,rss="], { timeout: 4000 }, (err, out) => {
      const result = new Map();
      if (!err) {
        for (const line of out.split("\n")) {
          const [pid, ppid, cpu, rss] = line.trim().split(/\s+/).map(Number);
          if (pid) result.set(pid, { ppid, cpu, rssMB: rss / 1024 });
        }
      }
      resolve(result);
    });
  });
}

async function refreshProcessTable() {
  try {
    if (isLinux) table = await readLinuxTable();
    else if (process.platform !== "win32") table = await readPsTable();
  } catch { /* keep the old table */ }
}

// Total CPU % and memory (MB) for a process and all of its descendants.
function usageForTree(rootPid) {
  let cpu = 0;
  let memoryMB = 0;
  const queue = [rootPid];
  const seen = new Set();

  while (queue.length) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);

    const info = table.get(pid);
    if (info) { cpu += info.cpu; memoryMB += info.rssMB; }

    for (const [childPid, child] of table) {
      if (child.ppid === pid) queue.push(childPid);
    }
  }
  return { cpu: Math.round(cpu * 10) / 10, memoryMB: Math.round(memoryMB) };
}

/* ---------- Whole-server metrics ---------- */

let lastCpu = sampleCpu();

function sampleCpu() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const value of Object.values(c.times)) total += value;
    idle += c.times.idle;
  }
  return { idle, total };
}

function serverMetrics() {
  const now = sampleCpu();
  const idleDelta = now.idle - lastCpu.idle;
  const totalDelta = now.total - lastCpu.total;
  lastCpu = now;
  const cpuPct = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;

  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();

  let disk = { usedPct: 0, usedGB: 0, totalGB: 0 };
  try {
    const s = fs.statfsSync(DATA_DIR);
    const total = s.blocks * s.bsize;
    const used = total - s.bavail * s.bsize;
    disk = {
      usedPct: total ? Math.round((used / total) * 100) : 0,
      usedGB: Math.round((used / 1e9) * 10) / 10,
      totalGB: Math.round((total / 1e9) * 10) / 10
    };
  } catch { /* statfs unavailable */ }

  return {
    cpu: { usedPct: Math.max(0, Math.min(100, cpuPct)), cores: os.cpus().length },
    memory: {
      usedPct: Math.round((usedMem / totalMem) * 100),
      usedMB: Math.round(usedMem / 1048576),
      totalMB: Math.round(totalMem / 1048576)
    },
    disk,
    uptimeSeconds: Math.round(os.uptime()),
    platform: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    nodeVersion: process.version
  };
}

module.exports = { refreshProcessTable, usageForTree, serverMetrics };

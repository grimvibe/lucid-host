// Deployment pipeline: fetch code (Git or zip) -> validate -> install -> build.
const fs = require("fs");
const path = require("path");
const db = require("./database");
const config = require("./config");
const runner = require("./runner");
const security = require("./security");
const { extractZip } = require("./zip");

const deploying = new Set();
const isWindows = process.platform === "win32";

class DeployError extends Error {}

function validateRepoUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw new DeployError("Enter a valid Git repository URL"); }

  if (url.protocol !== "https:") throw new DeployError("Only https:// repository URLs are allowed");
  if (url.username || url.password) {
    throw new DeployError("Do not put credentials in the URL. Use the access token field instead");
  }

  const host = url.hostname.toLowerCase();
  const blocked = host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":") ||
    host.endsWith(".local") || host.endsWith(".internal");
  if (blocked) throw new DeployError("That repository host is not allowed");

  return url.toString();
}

function validateBranch(branch) {
  if (!branch) return null;
  if (!/^[\w./-]{1,100}$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new DeployError("Invalid branch name");
  }
  return branch;
}

function flattenSingleFolder(dir) {
  const entries = fs.readdirSync(dir).filter(n => n !== "__MACOSX");
  if (entries.length !== 1) return;
  const inner = path.join(dir, entries[0]);
  if (!fs.statSync(inner).isDirectory()) return;

  for (const name of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, name), path.join(dir, name));
  }
  fs.rmSync(inner, { recursive: true, force: true });
}

function validateProjectFiles(project, appDir) {
  const has = f => fs.existsSync(path.join(appDir, f));

  if (project.runtime === "nodejs") {
    if (!has("package.json") && !project.startCommand) {
      throw new DeployError("No package.json found. This does not look like a Node.js project.");
    }
    if (has("package.json")) {
      try { JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")); }
      catch { throw new DeployError("package.json is not valid JSON"); }
    }
  } else {
    const hasPython = fs.readdirSync(appDir).some(f => f.endsWith(".py")) || has("requirements.txt");
    if (!hasPython) throw new DeployError("No Python files found. This does not look like a Python project.");
  }
}

function defaultInstall(project, appDir) {
  const has = f => fs.existsSync(path.join(appDir, f));

  if (project.runtime === "nodejs") {
    return has("package.json") ? "npm install --omit=dev --no-audit --no-fund" : null;
  }
  if (!has("requirements.txt")) return null;

  const python = isWindows ? "python" : "python3";
  const pip = `"${runner.venvBin(appDir, "pip")}"`;
  return `${python} -m venv .venv && ${pip} install --no-cache-dir -r requirements.txt`;
}

function setStatus(id, status, extra = {}) {
  const fields = { status, ...extra };
  const keys = Object.keys(fields);
  db.prepare(`UPDATE projects SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map(k => fields[k]), id);
}

/**
 * source: { type: "git", repoUrl, branch, token } | { type: "zip", buffer }
 */
async function deploy(projectId, source, { autoStart = true } = {}) {
  const id = Number(projectId);
  if (deploying.has(id)) throw Object.assign(new Error("A deployment is already in progress"), { status: 409 });
  deploying.add(id);

  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  const previousStatus = project.status === "deploying" ? "stopped" : project.status;
  const dirs = runner.ensureDirs(id);
  const staging = path.join(dirs.root, "app.new");

  try {
    await runner.stop(id);
    setStatus(id, "deploying", { lastError: null });
    runner.log(id, "sys", "=== Deployment started ===");

    fs.rmSync(staging, { recursive: true, force: true });

    if (source.type === "git") {
      const repoUrl = validateRepoUrl(source.repoUrl);
      const branch = validateBranch(source.branch);

      const args = ["clone", "--depth", "1"];
      if (branch) args.push("--branch", branch);
      args.push("--", repoUrl, staging);

      const env = { PATH: process.env.PATH, HOME: dirs.home, GIT_TERMINAL_PROMPT: "0", LANG: "C" };
      if (source.token) {
        const basic = Buffer.from(`x-access-token:${source.token}`).toString("base64");
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = "http.extraHeader";
        env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
      }

      runner.log(id, "sys", `Cloning ${repoUrl}${branch ? ` (branch ${branch})` : ""}`);
      const code = await runner.execSpec(id,
        { file: "git", args, options: { env, windowsHide: true } },
        { timeoutMs: 5 * 60 * 1000, label: "git clone", name: `lucid-${id}-git` });

      if (code !== 0) throw new DeployError("Could not clone the repository. Check the URL, branch and access token.");
      fs.rmSync(path.join(staging, ".git"), { recursive: true, force: true });
    } else if (source.type === "zip") {
      runner.log(id, "sys", `Extracting uploaded zip (${Math.round(source.buffer.length / 1024)} KB)`);
      try {
        extractZip(source.buffer, staging);
      } catch (error) {
        throw new DeployError(`Zip upload failed: ${error.message}`);
      }
    } else {
      throw new DeployError("Unknown deployment source");
    }

    flattenSingleFolder(staging);
    if (!fs.existsSync(staging) || fs.readdirSync(staging).length === 0) {
      throw new DeployError("The deployment contained no files");
    }

    validateProjectFiles(project, staging);

    // Swap the new code in only once it passed validation.
    fs.rmSync(dirs.app, { recursive: true, force: true });
    fs.renameSync(staging, dirs.app);

    const install = project.installCommand || defaultInstall(project, dirs.app);
    if (install) {
      runner.log(id, "sys", "Installing dependencies...");
      if (await runner.runCommand(id, install, { label: install }) !== 0) {
        throw new DeployError("Dependency installation failed. See the logs for details.");
      }
    }

    if (project.buildCommand) {
      runner.log(id, "sys", "Running build command...");
      if (await runner.runCommand(id, project.buildCommand, { label: project.buildCommand }) !== 0) {
        throw new DeployError("The build command failed. See the logs for details.");
      }
    }

    if (!runner.resolveStartCommand(project)) {
      throw new DeployError("Deployed, but no start command could be detected. Set one in project settings.");
    }

    setStatus(id, "stopped", {
      deployedAt: new Date().toISOString(),
      source: source.type,
      ...(source.type === "git"
        ? { repoUrl: validateRepoUrl(source.repoUrl), branch: validateBranch(source.branch) }
        : {}),
      lastError: null
    });
    runner.log(id, "sys", "=== Deployment finished ===");
    security.notify(project.ownerId, "success", `${project.name} was deployed successfully.`, id);

    if (autoStart) await runner.start(id);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    const message = error instanceof DeployError ? error.message : `Deployment failed: ${error.message}`;
    runner.log(id, "sys", `=== ${message} ===`);

    const stillHasCode = runner.hasCode(id);
    setStatus(id, stillHasCode ? "stopped" : previousStatus === "deploying" ? "registered" : previousStatus,
      { lastError: message });
    if (!stillHasCode) setStatus(id, "registered", { lastError: message });

    security.notify(project.ownerId, "error", `${project.name}: ${message}`, id);
    throw Object.assign(new Error(message), { status: error instanceof DeployError ? 400 : 500 });
  } finally {
    deploying.delete(id);
  }
}

function isDeploying(id) { return deploying.has(Number(id)); }

module.exports = { deploy, isDeploying, DeployError };

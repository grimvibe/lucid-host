const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, "data");

module.exports = {
  VERSION: "2.0.0",
  ROOT,
  PORT: Number(process.env.PORT) || 3000,
  DATA_DIR,
  PROJECTS_DIR: path.join(DATA_DIR, "projects"),
  LOGS_DIR: path.join(DATA_DIR, "logs"),

  // "process" runs bots as child processes on this machine.
  // "docker" runs every bot (and its install/build step) in its own container.
  RUNNER: process.env.RUNNER === "docker" ? "docker" : "process",
  DOCKER_NODE_IMAGE: process.env.DOCKER_NODE_IMAGE || "node:22-slim",
  DOCKER_PYTHON_IMAGE: process.env.DOCKER_PYTHON_IMAGE || "python:3.12-slim",

  // Set REGISTRATION_OPEN=false to stop new sign-ups after the first admin.
  REGISTRATION_OPEN: process.env.REGISTRATION_OPEN !== "false",
  // Set COOKIE_SECURE=true when serving over HTTPS.
  COOKIE_SECURE: process.env.COOKIE_SECURE === "true",
  TRUST_PROXY: process.env.TRUST_PROXY || "",

  SESSION_DAYS: 7,
  DEFAULT_MAX_PROJECTS: 5,
  DEFAULT_MEMORY_MB: 512,
  MAX_UPLOAD: "50mb",
  MAX_LOG_LINES: 1000,
  INSTALL_TIMEOUT_MS: 10 * 60 * 1000
};

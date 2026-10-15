const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { DATA_DIR } = require("./config");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "lucid-host.db"));

// Safer concurrent access.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    suspended INTEGER NOT NULL DEFAULT 0,
    maxProjects INTEGER NOT NULL DEFAULT 5,
    memoryMB INTEGER NOT NULL DEFAULT 512,
    createdAt TEXT NOT NULL,
    lastLoginAt TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    tokenHash TEXT PRIMARY KEY,
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    ip TEXT
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    runtime TEXT NOT NULL CHECK (runtime IN ('nodejs', 'python')),
    platform TEXT NOT NULL
      CHECK (platform IN ('whatsapp', 'telegram', 'discord', 'other')),
    status TEXT NOT NULL DEFAULT 'registered',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    projectId INTEGER,
    read INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    ts TEXT NOT NULL,
    total INTEGER NOT NULL,
    running INTEGER NOT NULL,
    stopped INTEGER NOT NULL,
    errors INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(userId, read);
  CREATE INDEX IF NOT EXISTS idx_snapshots_user ON snapshots(userId, ts);
`);

// Upgrade projects tables created by earlier versions of Lucid Host.
const projectColumns = new Set(
  db.prepare("PRAGMA table_info(projects)").all().map(c => c.name)
);

const addColumns = {
  ownerId: "INTEGER REFERENCES users(id) ON DELETE CASCADE",
  source: "TEXT",
  repoUrl: "TEXT",
  branch: "TEXT",
  installCommand: "TEXT",
  buildCommand: "TEXT",
  startCommand: "TEXT",
  envEncrypted: "TEXT",
  autoRestart: "INTEGER NOT NULL DEFAULT 1",
  desiredState: "TEXT NOT NULL DEFAULT 'stopped'",
  startedAt: "TEXT",
  deployedAt: "TEXT",
  lastExitCode: "INTEGER",
  lastError: "TEXT",
  restarts: "INTEGER NOT NULL DEFAULT 0"
};

for (const [name, definition] of Object.entries(addColumns)) {
  if (!projectColumns.has(name)) {
    db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
  }
}

db.exec("CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(ownerId)");

module.exports = db;

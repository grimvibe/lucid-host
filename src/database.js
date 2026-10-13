
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "../data");

fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "lucid-host.db");
const db = new Database(dbPath);

// Enable safer concurrent database access.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Create the projects table.
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
              runtime TEXT NOT NULL
                    CHECK (runtime IN ('nodejs', 'python')),
                        platform TEXT NOT NULL
                              CHECK (platform IN ('whatsapp', 'telegram', 'discord', 'other')),
                                  status TEXT NOT NULL DEFAULT 'registered',
                                      createdAt TEXT NOT NULL
                                        )
                                        `);

                                        module.exports = db;
                                        
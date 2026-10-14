
const express = require("express");
const path = require("path");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "../public")));

const allowedRuntimes = ["nodejs", "python"];
const allowedPlatforms = [
  "whatsapp",
  "telegram",
  "discord",
  "other"
];

app.get("/api", (req, res) => {
  res.json({
    name: "Lucid Host",
    version: "1.3.0",
    status: "online",
    supportedRuntimes: allowedRuntimes,
    supportedPlatforms: allowedPlatforms
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime()
  });
});

// List all projects from SQLite.
app.get("/api/projects", (req, res) => {
  const projects = db.prepare(`
    SELECT id, name, runtime, platform, status, createdAt
    FROM projects
    ORDER BY id DESC
  `).all();

  res.json({
    total: projects.length,
    projects
  });
});

// Register a project in SQLite.
app.post("/api/projects", (req, res) => {
  const { name, runtime, platform } = req.body;

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({
      error: "Project name is required"
    });
  }

  if (name.trim().length > 60) {
    return res.status(400).json({
      error: "Project name must be 60 characters or fewer"
    });
  }

  if (!allowedRuntimes.includes(runtime)) {
    return res.status(400).json({
      error: "Runtime must be nodejs or python"
    });
  }

  if (!allowedPlatforms.includes(platform)) {
    return res.status(400).json({
      error: "Invalid messaging platform"
    });
  }

  const createdAt = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO projects (name, runtime, platform, status, createdAt)
    VALUES (?, ?, ?, 'registered', ?)
  `).run(name.trim(), runtime, platform, createdAt);

  const project = db.prepare(`
    SELECT id, name, runtime, platform, status, createdAt
    FROM projects
    WHERE id = ?
  `).get(result.lastInsertRowid);

  res.status(201).json({
    message: "Project registered successfully",
    project
  });
});

// Get one project by ID.
app.get("/api/projects/:id", (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      error: "Invalid project ID"
    });
  }

  const project = db.prepare(`
    SELECT id, name, runtime, platform, status, createdAt
    FROM projects
    WHERE id = ?
  `).get(id);

  if (!project) {
    return res.status(404).json({
      error: "Project not found"
    });
  }

  res.json(project);
});

// Edit a project.
app.put("/api/projects/:id", (req, res) => {
  const id = Number(req.params.id);
  const { name, runtime, platform } = req.body;

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      error: "Invalid project ID"
    });
  }

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({
      error: "Project name is required"
    });
  }

  if (name.trim().length > 60) {
    return res.status(400).json({
      error: "Project name must be 60 characters or fewer"
    });
  }

  if (!allowedRuntimes.includes(runtime)) {
    return res.status(400).json({
      error: "Invalid runtime"
    });
  }

  if (!allowedPlatforms.includes(platform)) {
    return res.status(400).json({
      error: "Invalid platform"
    });
  }

  const result = db.prepare(`
    UPDATE projects
    SET name = ?, runtime = ?, platform = ?
    WHERE id = ?
  `).run(name.trim(), runtime, platform, id);

  if (result.changes === 0) {
    return res.status(404).json({
      error: "Project not found"
    });
  }

  const project = db.prepare(`
    SELECT id, name, runtime, platform, status, createdAt
    FROM projects
    WHERE id = ?
  `).get(id);

  res.json({
    message: "Project updated successfully",
    project
  });
});

// Delete a project.
app.delete("/api/projects/:id", (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      error: "Invalid project ID"
    });
  }

  const result = db.prepare(`
    DELETE FROM projects WHERE id = ?
  `).run(id);

  if (result.changes === 0) {
    return res.status(404).json({
      error: "Project not found"
    });
  }

  res.json({
    message: "Project deleted successfully",
    id
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lucid Host is running on port ${PORT}`);
});

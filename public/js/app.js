/* Lucid Host dashboard */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const state = {
    user: null,
    authMode: "login",
    projects: [],
    stats: null,
    server: null,
    notifs: { unread: 0, items: [] },
    selectedId: null,
    query: "",
    stream: null,
    streamId: null,
    adminTab: "users",
    detail: null
  };

  const RUNTIME = { nodejs: "Node.js", python: "Python" };
  const PLATFORM = { whatsapp: "WhatsApp", telegram: "Telegram", discord: "Discord", other: "Other" };
  const STATUS = { running: "Running", stopped: "Stopped", registered: "Not deployed", error: "Error", deploying: "Deploying" };

  /* ---------- helpers ---------- */
  const h = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls = "") => `<svg class="icon ${cls}"><use href="#i-${name}"/></svg>`;

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && state.user && !url.startsWith("/api/auth/")) {
      state.user = null;
      showAuth();
    }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || "Request failed"), { status: res.status });
    return data;
  }

  function toast(message, type = "") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    $("#toastRoot").appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function fmtUptime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}d ${hr}h`;
    if (hr) return `${hr}h ${m}m`;
    return `${m}m`;
  }
  const fmtMem = mb => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb || 0)} MB`);
  const fmtDate = iso => (iso ? new Date(iso).toLocaleString() : "—");
  function ago(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  const iconFor = p => (p.platform !== "other" ? `p-${p.platform}` : p.runtime === "python" ? "p-python" : "p-nodejs");
  const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

  // Progress bars use JS (not inline style attributes) so the strict CSP stays intact.
  function applyBars(root) {
    $$("[data-w]", root).forEach(el => {
      const v = Math.max(0, Math.min(100, Number(el.dataset.w) || 0));
      el.style.width = v + "%";
      el.classList.toggle("warn", v >= 70 && v < 90);
      el.classList.toggle("crit", v >= 90);
    });
  }

  function matches(p) {
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return [p.name, p.code, String(p.id), p.platform, p.runtime, p.owner].some(v => String(v || "").toLowerCase().includes(q));
  }

  /* ---------- modal ---------- */
  function openModal(html, mount) {
    closeModal();
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    back.addEventListener("mousedown", e => { if (e.target === back) closeModal(); });
    $("#modalRoot").appendChild(back);
    if (mount) mount(back.firstElementChild);
    const first = $("input, select, button.primary", back);
    if (first) first.focus();
  }
  function closeModal() { $("#modalRoot").replaceChildren(); }
  document.addEventListener("keydown", e => { if (e.key === "Escape") { closeModal(); closePopovers(); } });

  function confirmModal({ title, message, confirmText = "Confirm", danger = false }) {
    return new Promise(resolve => {
      openModal(`
        <h2>${h(title)}</h2><p class="muted">${h(message)}</p>
        <div class="btn-row" data-modal-actions>
          <button class="btn ${danger ? "danger" : "primary"}" data-yes type="button">${h(confirmText)}</button>
          <button class="btn" data-no type="button">Cancel</button>
        </div>`, m => {
        $("[data-yes]", m).addEventListener("click", () => { closeModal(); resolve(true); });
        $("[data-no]", m).addEventListener("click", () => { closeModal(); resolve(false); });
      });
    });
  }

  /* ---------- theme ---------- */
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $("#themeBtn use").setAttribute("href", theme === "dark" ? "#i-moon" : "#i-sun");
    try { localStorage.setItem("lucid-theme", theme); } catch { /* storage unavailable */ }
  }
  try { const t = localStorage.getItem("lucid-theme"); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }

  /* ---------- auth ---------- */
  function showAuth() {
    stopStream();
    $("#appView").hidden = true;
    $("#authView").hidden = false;
    api("GET", "/api/auth/status").then(s => {
      state.authMode = s.hasUsers ? state.authMode : "register";
      state.firstRun = !s.hasUsers;
      state.regOpen = s.registrationOpen;
      paintAuth();
    }).catch(() => paintAuth());
  }

  function paintAuth() {
    const reg = state.authMode === "register";
    $("#authTitle").textContent = state.firstRun ? "Create admin account" : reg ? "Create account" : "Sign in";
    $("#authSubtitle").textContent = state.firstRun
      ? "Welcome to Lucid Host. The first account becomes the administrator."
      : reg ? "Create an account to start hosting your bots." : "Welcome back. Sign in to manage your bots.";
    $("#emailField").hidden = !reg;
    $("#usernameLabel").textContent = reg ? "Username" : "Username or email";
    $("#authPassword").autocomplete = reg ? "new-password" : "current-password";
    $("#authSubmit").textContent = reg ? "Create account" : "Sign in";
    $("#authSwitchWrap").hidden = state.firstRun || (!reg && state.regOpen === false);
    $("#authSwitchText").textContent = reg ? "Already have an account?" : "New here?";
    $("#authSwitch").textContent = reg ? "Sign in" : "Create an account";
    $("#authMessage").textContent = "";
  }

  $("#authSwitch").addEventListener("click", () => {
    state.authMode = state.authMode === "login" ? "register" : "login";
    paintAuth();
  });

  $("#authForm").addEventListener("submit", async e => {
    e.preventDefault();
    const msg = $("#authMessage"), btn = $("#authSubmit");
    msg.className = "form-message";
    msg.textContent = "";
    btn.disabled = true;
    try {
      const username = $("#authUsername").value.trim();
      const password = $("#authPassword").value;
      const body = state.authMode === "register"
        ? { username, email: $("#authEmail").value.trim(), password }
        : { username, password };
      const data = await api("POST", state.authMode === "register" ? "/api/auth/register" : "/api/auth/login", body);
      $("#authPassword").value = "";
      await enterApp(data.user);
    } catch (error) {
      msg.className = "form-message error";
      msg.textContent = error.message;
    } finally {
      btn.disabled = false;
    }
  });

  async function logout() {
    try { await api("POST", "/api/auth/logout"); } catch { /* already signed out */ }
    state.user = null;
    state.projects = [];
    location.hash = "#/dashboard";
    showAuth();
  }

  async function enterApp(user) {
    state.user = user;
    $("#authView").hidden = true;
    $("#appView").hidden = false;
    $("#userName").textContent = user.username;
    $("#userRole").textContent = user.role === "admin" ? "Administrator" : "User";
    $("#userAvatar").textContent = user.username[0].toUpperCase();
    $("#nav").innerHTML = [
      ["dashboard", "Dashboard"], ["projects", "Projects"], ["servers", "Servers"], ["logs", "Logs"],
      ...(user.role === "admin" ? [["users", "Users"]] : []), ["settings", "Settings"]
    ].map(([id, label]) => `<a href="#/${id}" data-nav="${id}">${icon(id)}<span>${label}</span></a>`).join("");
    setTheme(document.documentElement.dataset.theme || "dark");
    await refreshAll();
    route();
    startPolling();
  }

  /* ---------- data ---------- */
  async function refreshAll() {
    const [projects, stats, server, notifs] = await Promise.all([
      api("GET", "/api/projects"), api("GET", "/api/stats"), api("GET", "/api/server"), api("GET", "/api/notifications")
    ]);
    state.projects = projects.projects.slice().sort((a, b) => a.id - b.id);
    state.stats = stats;
    state.server = server;
    state.notifs = notifs;
    $("#versionText").textContent = "v" + server.version;
    paintBell();
    if (!state.projects.some(p => p.id === state.selectedId)) {
      const pick = state.projects.find(p => p.status === "running") || state.projects[0];
      state.selectedId = pick ? pick.id : null;
    }
  }

  function paintBell() {
    const b = $("#bellBadge");
    b.hidden = !state.notifs.unread;
    b.textContent = state.notifs.unread > 9 ? "9+" : state.notifs.unread;
  }

  let pollTimer = null;
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (document.hidden || !state.user) return;
      try {
        await refreshAll();
        $("#apiPill").className = "pill online";
        $("#apiPill span").textContent = "Online";
        repaintLive();
      } catch {
        $("#apiPill").className = "pill offline";
        $("#apiPill span").textContent = "Offline";
      }
    }, 4000);
  }

  /* ---------- routing ---------- */
  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    return { page: parts[0] || "dashboard", id: parts[1], tab: parts[2] };
  }

  function route() {
    if (!state.user) return;
    closePopovers();
    stopStream();
    $("#sidebar").classList.remove("open");
    $("#scrim").hidden = true;

    const r = parseRoute();
    const navKey = r.page === "project" ? "projects" : r.page;
    $$("#nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === navKey));

    const pages = { dashboard: renderDashboard, projects: renderProjects, servers: renderServers, logs: renderLogsPage, users: renderUsers, settings: renderSettings, project: renderProject };
    const page = pages[r.page] || renderDashboard;
    if (r.page === "users" && state.user.role !== "admin") { location.hash = "#/dashboard"; return; }
    document.title = "Lucid Host | " + cap(r.page === "project" ? "Project" : r.page);
    page(r);
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  // Repaint only the live parts so forms and open menus are not disturbed.
  function repaintLive() {
    const r = parseRoute();
    if (r.page === "dashboard") {
      paintStats(); paintServer(); syncLiveSelect(); paintQuick();
      if (!$(".menu:not([hidden])", $("#projectGrid") || document.body)) paintGrid($("#projectGrid"), state.projects.filter(matches).slice(0, 4));
    } else if (r.page === "projects") {
      if (!$(".menu:not([hidden])", $("#projectGrid") || document.body)) paintGrid($("#projectGrid"), state.projects.filter(matches));
    } else if (r.page === "servers") {
      paintServerPage();
    } else if (r.page === "project") {
      refreshDetail(true);
    }
  }

  /* ---------- project cards ---------- */
  function cardHTML(p) {
    const on = p.status === "running";
    const busy = p.status === "deploying";
    return `
      <article class="project ${state.selectedId === p.id ? "selected" : ""}" data-id="${p.id}">
        <div class="p-top">
          <svg class="p-badge"><use href="#${iconFor(p)}"/></svg>
          <div class="p-info">
            <div class="p-name">${h(p.name)}</div>
            <div class="p-meta">${RUNTIME[p.runtime]} · ${PLATFORM[p.platform]}</div>
            <div class="p-code">${h(p.code)}</div>
          </div>
          <span class="status ${p.status}">${STATUS[p.status] || h(p.status)}</span>
        </div>
        <div class="p-stats">
          <div class="p-stat"><small>CPU</small><strong>${on ? Math.round(p.cpu) : 0}%</strong></div>
          <div class="p-stat"><small>Memory</small><strong>${on ? fmtMem(p.memoryMB) : "0 MB"}</strong></div>
          <div class="p-stat"><small>Uptime</small><strong>${on ? fmtUptime(p.uptimeSeconds) : "0m"}</strong></div>
          <div class="p-actions">
            <button class="sq go" data-action="start" data-id="${p.id}" type="button" title="Start" ${on || busy ? "disabled" : ""}>${icon("play")}</button>
            ${on || p.status === "error" ? `<button class="sq" data-action="stop" data-id="${p.id}" type="button" title="Stop">${icon("stop")}</button>` : ""}
            <button class="sq" data-action="more" data-id="${p.id}" type="button" title="More">${icon("more")}</button>
            <div class="menu" hidden>
              <button type="button" data-action="open" data-id="${p.id}">Details</button>
              <button type="button" data-action="open-deploy" data-id="${p.id}">Deploy</button>
              <button type="button" data-action="open-logs" data-id="${p.id}">Logs</button>
              <button type="button" data-action="restart" data-id="${p.id}">Restart</button>
              <button type="button" class="danger-item" data-action="delete" data-id="${p.id}">Delete</button>
            </div>
          </div>
        </div>
      </article>`;
  }

  function paintGrid(el, list) {
    if (!el) return;
    if (!list.length) {
      el.innerHTML = state.projects.length
        ? `<div class="empty"><strong>No matching projects</strong>Try a different search.</div>`
        : `<div class="empty"><strong>No projects yet</strong>Create your first project to start hosting a bot.<div class="btn-row" data-center><button class="btn primary" data-action="add" type="button">${icon("plus", "sm")} Add Project</button></div></div>`;
      return;
    }
    el.innerHTML = list.map(cardHTML).join("");
  }

  /* ---------- dashboard ---------- */
  function greeting() {
    const hr = new Date().getHours();
    return hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  }

  function renderDashboard() {
    $("#view").innerHTML = `
      <div class="dash-grid">
        <div class="dash-left">
          <section class="greeting">
            <h1>${greeting()}, ${h(cap(state.user.username))} 👋</h1>
            <p>Here's what's happening with your projects today.</p>
          </section>
          <section class="stats" id="statCards"></section>
          <section class="panel">
            <div class="panel-head">
              <div class="panel-title">
                <span class="title-icon">${icon("cube")}</span>
                <div><h2>Your Projects</h2><small>Manage and control your bot and application projects.</small></div>
              </div>
              <div class="btn-row">
                <button class="btn sm" data-action="refresh" type="button">${icon("refresh", "sm")} Refresh</button>
                <button class="btn sm primary" data-action="add" type="button">${icon("plus", "sm")} Add Project</button>
                <a class="btn sm" href="#/projects">View All ${icon("arrow-right", "sm")}</a>
              </div>
            </div>
            <div class="project-grid" id="projectGrid"></div>
          </section>
        </div>
        <div class="dash-right">
          <section class="panel" id="serverPanel"></section>
          <section class="panel" id="livePanel">
            <div class="panel-head">
              <div class="panel-title"><span class="title-icon">${icon("terminal")}</span><h3>Live Logs</h3></div>
              <a class="link" href="#/logs">View All ${icon("arrow-right", "sm")}</a>
            </div>
            <div class="terminal" id="liveTerm"></div>
            <div class="log-foot"><span><i class="dot live-dot"></i> <select id="liveSelect" aria-label="Project for live logs"></select></span><span class="live" id="liveBadge">Live</span></div>
          </section>
          <section class="panel quick-panel" id="quickPanel"></section>
        </div>
      </div>`;
    paintStats();
    paintGrid($("#projectGrid"), state.projects.filter(matches).slice(0, 4));
    paintServer();
    syncLiveSelect(true);
    paintQuick();
    attachStream("#liveTerm", state.selectedId, 60);
  }

  function trendHTML(key) {
    const t = state.stats.trends[key];
    if (t === null || t === undefined) return `<div class="trend">— vs last 7 days</div>`;
    const up = t > 0;
    const goodWhenUp = key === "total" || key === "running";
    const good = t === 0 ? null : up === goodWhenUp;
    return `<div class="trend ${good === null ? "" : good ? "good" : "bad"}"><b>${t === 0 ? "" : icon(up ? "arrow-up" : "arrow-down", "sm")}${Math.abs(t)}%</b> vs last 7 days</div>`;
  }

  function paintStats() {
    const el = $("#statCards");
    if (!el || !state.stats) return;
    const s = state.stats;
    const card = (cls, ic, label, value, key) => `
      <div class="panel stat"><div class="s-icon ${cls}">${icon(ic)}</div>
        <div><div class="s-label">${label}</div><div class="s-num">${value}</div>${trendHTML(key)}</div></div>`;
    el.innerHTML =
      card("s-blue", "cube", "Total Projects", s.total, "total") +
      card("s-teal", "activity", "Running", s.running, "running") +
      card("s-indigo", "pause", "Stopped", s.stopped, "stopped") +
      card("s-red", "alert", "Errors", s.errors, "errors");
  }

  function paintServer() {
    const el = $("#serverPanel");
    if (!el || !state.server) return;
    const s = state.server;
    const row = (label, pct) => `<div class="meter"><div class="meter-row"><span>${label}</span><b>${pct}%</b></div><div class="bar"><i data-w="${pct}"></i></div></div>`;
    el.innerHTML = `
      <div class="panel-head">
        <div class="panel-title"><span class="title-icon">${icon("servers")}</span><h3>Server Status</h3></div>
        <span class="pill online"><i></i>Online</span>
      </div>
      ${row("CPU Usage", s.cpu.usedPct)}${row("Memory Usage", s.memory.usedPct)}${row("Disk Usage", s.disk.usedPct)}`;
    applyBars(el);
  }

  function syncLiveSelect(force) {
    const sel = $("#liveSelect");
    if (!sel) return;
    const sig = state.projects.map(p => p.id + p.name).join("|") + state.selectedId;
    if (!force && sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    sel.innerHTML = state.projects.length
      ? state.projects.map(p => `<option value="${p.id}" ${p.id === state.selectedId ? "selected" : ""}>${h(p.name)}</option>`).join("")
      : `<option>No projects</option>`;
    sel.disabled = !state.projects.length;
  }

  function paintQuick() {
    const el = $("#quickPanel");
    if (!el) return;
    const p = state.projects.find(x => x.id === state.selectedId);
    const off = p ? "" : "disabled";
    el.innerHTML = `
      <div class="panel-head"><div class="panel-title"><span class="title-icon">${icon("settings")}</span><h3>Quick Actions</h3></div></div>
      <div class="quick">
        <button type="button" class="q-blue" data-action="q-logs" ${off}>${icon("logs", "lg")}View Logs</button>
        <button type="button" class="q-blue" data-action="q-restart" ${off}>${icon("restart", "lg")}Restart</button>
        <button type="button" class="q-red" data-action="q-stop" ${off || (p.status !== "running" ? "disabled" : "")}>${icon("stop", "lg")}Stop</button>
        <button type="button" class="q-grey" data-action="q-settings" ${off}>${icon("settings", "lg")}Settings</button>
      </div>`;
  }

  /* ---------- live logs ---------- */
  function stopStream() {
    if (state.stream) { state.stream.close(); state.stream = null; }
    state.streamId = null;
  }

  function logLine(e) {
    const t = new Date(e.t);
    const ts = [t.getHours(), t.getMinutes(), t.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
    const lv = e.s === "err" ? "ERROR" : e.s === "sys" ? "SYSTEM" : "INFO";
    return `<div class="ln"><span class="ts">[${ts}]</span><span class="lv ${e.s}">${lv}</span>${h(e.m)}</div>`;
  }

  async function attachStream(termSel, id, initial = 100, max = 400) {
    stopStream();
    const term = $(termSel);
    if (!term) return;
    const badge = $("#liveBadge");
    if (!id) {
      term.innerHTML = `<div class="none">No project selected. Create a project to see its logs here.</div>`;
      if (badge) { badge.textContent = "Idle"; badge.classList.add("off"); }
      return;
    }
    state.streamId = id;
    try {
      const data = await api("GET", `/api/projects/${id}/logs?limit=${initial}`);
      if (state.streamId !== id) return;
      term.innerHTML = data.lines.length ? data.lines.map(logLine).join("") : `<div class="none">No output yet. Start the project to see its logs.</div>`;
      term.scrollTop = term.scrollHeight;
    } catch (error) {
      term.innerHTML = `<div class="none">${h(error.message)}</div>`;
      return;
    }

    const es = new EventSource(`/api/projects/${id}/logs/stream`);
    state.stream = es;
    es.onopen = () => { if (badge) { badge.textContent = "Live"; badge.classList.remove("off"); } };
    es.onerror = () => { if (badge) { badge.textContent = "Reconnecting"; badge.classList.add("off"); } };
    es.onmessage = ev => {
      const none = $(".none", term);
      if (none) none.remove();
      const nearBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 60;
      term.insertAdjacentHTML("beforeend", logLine(JSON.parse(ev.data)));
      while (term.childElementCount > max) term.firstElementChild.remove();
      if (nearBottom) term.scrollTop = term.scrollHeight;
    };
  }

  /* ---------- projects page ---------- */
  function renderProjects() {
    $("#view").innerHTML = `
      <div class="page-head">
        <div><h1>Projects</h1><p>Manage and control all of your bots and applications.</p></div>
        <div class="btn-row">
          <button class="btn" data-action="refresh" type="button">${icon("refresh", "sm")} Refresh</button>
          <button class="btn primary" data-action="add" type="button">${icon("plus", "sm")} Add Project</button>
        </div>
      </div>
      <div class="project-grid wide" id="projectGrid"></div>`;
    paintGrid($("#projectGrid"), state.projects.filter(matches));
  }

  /* ---------- servers ---------- */
  function renderServers() {
    $("#view").innerHTML = `
      <div class="page-head"><div><h1>Servers</h1><p>Health of the machine running Lucid Host.</p></div></div>
      <div class="section-gap">
        <section class="panel" id="serverPage"></section>
        <section class="panel" id="runningPanel"></section>
      </div>`;
    paintServerPage();
  }

  function paintServerPage() {
    const el = $("#serverPage");
    if (!el || !state.server) return;
    const s = state.server;
    const row = (label, pct, extra) => `<div class="meter"><div class="meter-row"><span>${label}</span><b>${pct}%${extra ? ` <span class="muted">· ${extra}</span>` : ""}</b></div><div class="bar"><i data-w="${pct}"></i></div></div>`;
    el.innerHTML = `
      <div class="panel-head"><div class="panel-title"><span class="title-icon">${icon("servers")}</span><h3>Server Status</h3></div><span class="pill online"><i></i>Online</span></div>
      ${row("CPU Usage", s.cpu.usedPct, `${s.cpu.cores} cores`)}
      ${row("Memory Usage", s.memory.usedPct, `${fmtMem(s.memory.usedMB)} of ${fmtMem(s.memory.totalMB)}`)}
      ${row("Disk Usage", s.disk.usedPct, s.disk.totalGB ? `${s.disk.usedGB} of ${s.disk.totalGB} GB` : "")}
      <dl class="kv" data-spaced>
        <dt>Uptime</dt><dd>${fmtUptime(s.uptimeSeconds)}</dd>
        <dt>Runner</dt><dd>${s.runner === "docker" ? "Docker containers" : "Local processes"}</dd>
        <dt>Version</dt><dd>${h(s.version)}</dd>
        ${s.hostname ? `<dt>Host</dt><dd>${h(s.hostname)}</dd><dt>Platform</dt><dd>${h(s.platform)}</dd><dt>Node.js</dt><dd>${h(s.nodeVersion)}</dd>` : ""}
      </dl>`;
    applyBars(el);

    const run = state.projects.filter(p => p.status === "running");
    $("#runningPanel").innerHTML = `
      <div class="panel-head"><div class="panel-title"><span class="title-icon">${icon("activity")}</span><h3>Running projects</h3></div></div>
      ${run.length ? `<div class="table-wrap"><table><thead><tr><th>Project</th><th>CPU</th><th>Memory</th><th>Limit</th><th>Uptime</th></tr></thead><tbody>
        ${run.map(p => `<tr><td>${h(p.name)}</td><td>${Math.round(p.cpu)}%</td><td>${fmtMem(p.memoryMB)}</td><td>${p.memoryLimitMB ? fmtMem(p.memoryLimitMB) : "—"}</td><td>${fmtUptime(p.uptimeSeconds)}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">No projects are running right now.</p>`}`;
  }

  /* ---------- logs page ---------- */
  function renderLogsPage() {
    $("#view").innerHTML = `
      <div class="page-head"><div><h1>Logs</h1><p>Real-time output from your projects.</p></div>
        <div class="btn-row">
          <select id="logProject" aria-label="Project">${state.projects.map(p => `<option value="${p.id}" ${p.id === state.selectedId ? "selected" : ""}>${h(p.name)}</option>`).join("") || "<option>No projects</option>"}</select>
          <button class="btn" data-action="clear-logs" type="button">${icon("trash", "sm")} Clear</button>
        </div></div>
      <section class="panel"><div class="terminal big" id="bigTerm"></div>
      <div class="log-foot"><span class="muted">Showing the latest output</span><span class="live" id="liveBadge">Live</span></div></section>`;
    attachStream("#bigTerm", state.selectedId, 300, 800);
    const sel = $("#logProject");
    if (sel) sel.addEventListener("change", () => { state.selectedId = Number(sel.value); attachStream("#bigTerm", state.selectedId, 300, 800); });
  }

  /* ---------- project details ---------- */
  const TABS = [["overview", "Overview"], ["deploy", "Deploy"], ["env", "Environment"], ["logs", "Logs"], ["settings", "Settings"]];

  async function renderProject(r) {
    const id = Number(r.id);
    const tab = TABS.some(t => t[0] === r.tab) ? r.tab : "overview";
    $("#view").innerHTML = `<p class="muted">Loading…</p>`;
    try {
      state.detail = await api("GET", `/api/projects/${id}`);
    } catch (error) {
      $("#view").innerHTML = `<div class="empty"><strong>${h(error.message)}</strong><a class="btn" href="#/projects">Back to projects</a></div>`;
      return;
    }
    state.selectedId = id;
    $("#view").innerHTML = `
      <div class="page-head" id="detailHead"></div>
      <div class="tabs">${TABS.map(([k, l]) => `<button type="button" data-tab="${k}" class="${k === tab ? "active" : ""}">${l}</button>`).join("")}</div>
      <div id="tabBody"></div>`;
    paintDetailHead();
    state.tab = tab;
    renderTab(tab);
  }

  function paintDetailHead() {
    const p = state.detail, el = $("#detailHead");
    if (!p || !el) return;
    const on = p.status === "running";
    el.innerHTML = `
      <div class="panel-title">
        <svg class="p-badge"><use href="#${iconFor(p)}"/></svg>
        <div><h1>${h(p.name)}</h1><p>${RUNTIME[p.runtime]} · ${PLATFORM[p.platform]} · ${h(p.code)}</p></div>
        <span class="status ${p.status}">${STATUS[p.status] || h(p.status)}</span>
      </div>
      <div class="btn-row">
        <button class="btn" data-action="d-start" type="button" ${on || p.status === "deploying" ? "disabled" : ""}>${icon("play", "sm")} Start</button>
        <button class="btn" data-action="d-restart" type="button" ${p.deployed ? "" : "disabled"}>${icon("restart", "sm")} Restart</button>
        <button class="btn" data-action="d-stop" type="button" ${on || p.status === "error" ? "" : "disabled"}>${icon("stop", "sm")} Stop</button>
      </div>`;
  }

  async function refreshDetail(quiet) {
    const r = parseRoute();
    try {
      state.detail = await api("GET", `/api/projects/${Number(r.id)}`);
      paintDetailHead();
      if (state.tab === "overview") paintOverview();
    } catch (error) { if (!quiet) toast(error.message, "error"); }
  }

  function renderTab(tab) {
    state.tab = tab;
    $$(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    stopStream();
    const body = $("#tabBody");
    if (tab === "overview") { body.innerHTML = `<div class="section-gap" id="ovBody"></div>`; paintOverview(); }
    else if (tab === "deploy") paintDeploy(body);
    else if (tab === "env") paintEnv(body);
    else if (tab === "logs") {
      body.innerHTML = `<section class="panel"><div class="panel-head"><div class="panel-title"><h3>Live output</h3></div><div class="btn-row"><span class="live" id="liveBadge">Live</span><button class="btn sm" data-action="clear-logs" type="button">${icon("trash", "sm")} Clear</button></div></div><div class="terminal big" id="bigTerm"></div></section>`;
      attachStream("#bigTerm", state.detail.id, 300, 800);
    } else paintSettings(body);
  }

  function paintOverview() {
    const el = $("#ovBody");
    if (!el) return;
    const p = state.detail, on = p.status === "running";
    el.innerHTML = `
      ${p.lastError && p.status !== "running" ? `<div class="note err-note">${h(p.lastError)}</div>` : ""}
      ${!p.deployed ? `<div class="note">This project has no code yet. Open the <a class="link" href="#/project/${p.id}/deploy">Deploy tab</a> to connect a Git repository or upload a zip.</div>` : ""}
      <div class="stats">
        <div class="panel stat"><div><div class="s-label">CPU</div><div class="s-num">${on ? Math.round(p.cpu) : 0}%</div></div></div>
        <div class="panel stat"><div><div class="s-label">Memory</div><div class="s-num">${on ? fmtMem(p.memoryMB) : "0 MB"}</div>${p.memoryLimitMB ? `<div class="trend">limit ${fmtMem(p.memoryLimitMB)}</div>` : ""}</div></div>
        <div class="panel stat"><div><div class="s-label">Uptime</div><div class="s-num">${on ? fmtUptime(p.uptimeSeconds) : "0m"}</div></div></div>
        <div class="panel stat"><div><div class="s-label">Restarts</div><div class="s-num">${p.restarts}</div></div></div>
      </div>
      <section class="panel"><dl class="kv">
        <dt>Project ID</dt><dd>${h(p.code)}</dd>
        <dt>Runtime</dt><dd>${RUNTIME[p.runtime]}</dd>
        <dt>Platform</dt><dd>${PLATFORM[p.platform]}</dd>
        <dt>Source</dt><dd>${p.source === "git" ? `Git: ${h(p.repoUrl || "")}${p.branch ? ` (${h(p.branch)})` : ""}` : p.source === "zip" ? "Zip upload" : "Not deployed"}</dd>
        <dt>Start command</dt><dd><code>${h(p.startCommand || "auto-detected")}</code></dd>
        <dt>Auto-restart</dt><dd>${p.autoRestart ? "On" : "Off"}</dd>
        <dt>Environment</dt><dd>${p.envCount} variable${p.envCount === 1 ? "" : "s"}</dd>
        <dt>Created</dt><dd>${fmtDate(p.createdAt)}</dd>
        <dt>Last deployed</dt><dd>${fmtDate(p.deployedAt)}</dd>
        ${p.owner ? `<dt>Owner</dt><dd>${h(p.owner)}</dd>` : ""}
      </dl></section>`;
  }

  function commandsFields(p) {
    return `
      <label class="field wide"><span>Install command</span><input type="text" id="fInstall" maxlength="500" value="${h(p.installCommand || "")}" placeholder="Auto: npm install / pip install -r requirements.txt"></label>
      <label class="field wide"><span>Build command <small>(optional)</small></span><input type="text" id="fBuild" maxlength="500" value="${h(p.buildCommand || "")}" placeholder="e.g. npm run build"></label>
      <label class="field wide"><span>Start command</span><input type="text" id="fStart" maxlength="500" value="${h(p.startCommand || "")}" placeholder="Auto: npm start, index.js, main.py …"></label>
      <label class="check wide"><input type="checkbox" id="fAuto" ${p.autoRestart ? "checked" : ""}> Restart automatically if it crashes</label>`;
  }

  function paintDeploy(body) {
    const p = state.detail;
    body.innerHTML = `
      <div class="section-gap">
        <section class="panel">
          <div class="panel-head"><div class="panel-title"><span class="title-icon">${icon("git")}</span><div><h3>Deploy from Git</h3><small>Public repositories work as-is. Private ones need an access token.</small></div></div></div>
          <form id="gitForm" class="form-grid">
            <label class="field wide"><span>Repository URL (https)</span><input type="url" id="gUrl" required value="${h(p.repoUrl || "")}" placeholder="https://github.com/you/your-bot.git"></label>
            <label class="field"><span>Branch <small>(optional)</small></span><input type="text" id="gBranch" maxlength="100" value="${h(p.branch || "")}" placeholder="main"></label>
            <label class="field"><span>Access token <small>(optional, never stored)</small></span><input type="password" id="gToken" autocomplete="off" placeholder="ghp_…"></label>
            <div class="wide btn-row"><button class="btn primary" type="submit">${icon("git", "sm")} Deploy from Git</button></div>
          </form>
        </section>
        <section class="panel">
          <div class="panel-head"><div class="panel-title"><span class="title-icon">${icon("upload")}</span><div><h3>Upload a zip</h3><small>Up to 50 MB. A single top-level folder is handled automatically.</small></div></div></div>
          <div class="dropzone" id="drop" tabindex="0">${icon("upload", "lg")}<p><strong>Drop a .zip here</strong> or click to choose a file</p></div>
          <input type="file" id="zipInput" accept=".zip,application/zip" hidden>
        </section>
        <section class="panel">
          <div class="panel-head"><div class="panel-title"><span class="title-icon">${icon("terminal")}</span><div><h3>Build &amp; run commands</h3><small>Leave blank to auto-detect. Used on the next deploy.</small></div></div></div>
          <form id="cmdForm" class="form-grid">${commandsFields(p)}
            <div class="wide btn-row"><button class="btn primary" type="submit">Save settings</button></div>
          </form>
        </section>
      </div>`;
    $("#gitForm").addEventListener("submit", async e => {
      e.preventDefault();
      await deploy({ repoUrl: $("#gUrl").value.trim(), branch: $("#gBranch").value.trim() || null, token: $("#gToken").value || undefined });
      $("#gToken").value = "";
    });
    const drop = $("#drop"), input = $("#zipInput");
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("keydown", e => { if (e.key === "Enter") input.click(); });
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) uploadZip(e.dataTransfer.files[0]); });
    input.addEventListener("change", () => { if (input.files[0]) uploadZip(input.files[0]); });
    $("#cmdForm").addEventListener("submit", e => { e.preventDefault(); saveProject(); });
  }

  async function deploy(body) {
    try {
      await api("POST", `/api/projects/${state.detail.id}/deploy`, body);
      toast("Deployment started. Watching the logs…", "success");
      location.hash = `#/project/${state.detail.id}/logs`;
    } catch (error) { toast(error.message, "error"); }
  }

  async function uploadZip(file) {
    if (!/\.zip$/i.test(file.name)) return toast("Please choose a .zip file", "error");
    if (file.size > 50 * 1024 * 1024) return toast("That file is larger than 50 MB", "error");
    try {
      const res = await fetch(`/api/projects/${state.detail.id}/upload`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/zip" }, body: file
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed");
      toast("Upload received. Deploying…", "success");
      location.hash = `#/project/${state.detail.id}/logs`;
    } catch (error) { toast(error.message, "error"); }
  }

  async function saveProject() {
    const p = state.detail;
    const val = id => { const el = $(id); return el ? el.value.trim() : undefined; };
    const body = {
      name: val("#sName") ?? p.name,
      runtime: val("#sRuntime") ?? p.runtime,
      platform: val("#sPlatform") ?? p.platform,
      installCommand: val("#fInstall") ?? p.installCommand,
      buildCommand: val("#fBuild") ?? p.buildCommand,
      startCommand: val("#fStart") ?? p.startCommand,
      autoRestart: $("#fAuto") ? $("#fAuto").checked : p.autoRestart
    };
    try {
      const data = await api("PUT", `/api/projects/${p.id}`, body);
      state.detail = data.project;
      paintDetailHead();
      toast("Settings saved", "success");
    } catch (error) { toast(error.message, "error"); }
  }

  async function paintEnv(body) {
    body.innerHTML = `<section class="panel"><p class="muted">Loading…</p></section>`;
    let keys = [];
    try { keys = (await api("GET", `/api/projects/${state.detail.id}/env`)).env.map(e => e.key); } catch (error) { toast(error.message, "error"); }
    const row = (key = "", saved = false) => `
      <div class="env-row" data-saved="${saved ? 1 : 0}">
        <input type="text" class="env-key" placeholder="VARIABLE_NAME" maxlength="64" value="${h(key)}" ${saved ? "readonly" : ""}>
        <input type="password" class="env-val" autocomplete="off" placeholder="${saved ? "•••••••• (saved — type to replace)" : "value"}">
        <button class="sq" type="button" data-action="env-remove" title="Remove">${icon("x")}</button>
      </div>`;
    body.innerHTML = `
      <section class="panel">
        <div class="panel-head"><div class="panel-title"><span class="title-icon">${icon("lock")}</span><div><h3>Environment variables</h3><small>Encrypted at rest and never shown again. Restart the project to apply changes.</small></div></div></div>
        <div id="envRows">${keys.map(k => row(k, true)).join("")}</div>
        <div class="btn-row"><button class="btn" type="button" data-action="env-add">${icon("plus", "sm")} Add variable</button><button class="btn primary" type="button" data-action="env-save">Save variables</button></div>
        <div class="form-message" id="envMsg"></div>
      </section>`;
    body.dataset.rowTpl = row();
  }

  function paintSettings(body) {
    const p = state.detail;
    body.innerHTML = `
      <div class="section-gap">
        <section class="panel">
          <div class="panel-head"><div class="panel-title"><h3>Project settings</h3></div></div>
          <form id="setForm" class="form-grid">
            <label class="field wide"><span>Name</span><input type="text" id="sName" maxlength="60" required value="${h(p.name)}"></label>
            <label class="field"><span>Runtime</span><select id="sRuntime">${Object.entries(RUNTIME).map(([k, v]) => `<option value="${k}" ${p.runtime === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
            <label class="field"><span>Messaging platform</span><select id="sPlatform">${Object.entries(PLATFORM).map(([k, v]) => `<option value="${k}" ${p.platform === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
            ${commandsFields(p)}
            <div class="wide btn-row"><button class="btn primary" type="submit">Save changes</button></div>
          </form>
        </section>
        <section class="panel">
          <div class="panel-head"><div class="panel-title"><h3>Danger zone</h3></div></div>
          <p class="muted">Deleting a project stops it and removes its files and logs. This cannot be undone.</p>
          <div class="btn-row" data-spaced><button class="btn danger" type="button" data-action="delete" data-id="${p.id}">${icon("trash", "sm")} Delete project</button></div>
        </section>
      </div>`;
    $("#setForm").addEventListener("submit", e => { e.preventDefault(); saveProject(); });
  }

  /* ---------- users / admin ---------- */
  async function renderUsers() {
    $("#view").innerHTML = `
      <div class="page-head"><div><h1>Users</h1><p>Manage accounts, limits and activity across the platform.</p></div></div>
      <div class="tabs">${[["users", "Users"], ["projects", "All projects"], ["audit", "Audit log"]].map(([k, l]) => `<button type="button" data-admintab="${k}" class="${state.adminTab === k ? "active" : ""}">${l}</button>`).join("")}</div>
      <section class="panel"><div class="table-wrap" id="adminBody"><p class="muted">Loading…</p></div></section>`;
    await paintAdmin();
  }

  async function paintAdmin() {
    const el = $("#adminBody");
    if (!el) return;
    $$("[data-admintab]").forEach(b => b.classList.toggle("active", b.dataset.admintab === state.adminTab));
    try {
      if (state.adminTab === "users") {
        const { users } = await api("GET", "/api/admin/users");
        const q = state.query.trim().toLowerCase();
        const list = users.filter(u => !q || [u.username, u.email, String(u.id)].some(v => v.toLowerCase().includes(q)));
        el.innerHTML = `<table><thead><tr><th>User</th><th>Role</th><th>Projects</th><th>Max projects</th><th>Memory (MB)</th><th>Last login</th><th></th></tr></thead><tbody>
          ${list.map(u => `<tr data-uid="${u.id}">
            <td><strong>${h(u.username)}</strong><br><span class="muted">${h(u.email)}</span></td>
            <td><span class="tag ${u.role === "admin" ? "admin" : ""}">${u.role}</span>${u.suspended ? ' <span class="tag warn">suspended</span>' : ""}</td>
            <td>${u.projectCount}</td>
            <td><input type="number" min="0" max="1000" value="${u.maxProjects}" data-limit="maxProjects"></td>
            <td><input type="number" min="64" max="65536" step="64" value="${u.memoryMB}" data-limit="memoryMB"></td>
            <td>${u.lastLoginAt ? ago(u.lastLoginAt) : "never"}</td>
            <td><div class="btn-row">
              <button class="btn sm" data-action="u-save" type="button">Save</button>
              <button class="btn sm" data-action="u-role" data-role="${u.role === "admin" ? "user" : "admin"}" type="button">${u.role === "admin" ? "Make user" : "Make admin"}</button>
              <button class="btn sm" data-action="u-suspend" data-on="${u.suspended ? 0 : 1}" type="button">${u.suspended ? "Restore" : "Suspend"}</button>
              <button class="btn sm danger" data-action="u-delete" type="button">Delete</button>
            </div></td></tr>`).join("")}</tbody></table>`;
      } else if (state.adminTab === "projects") {
        const { projects } = await api("GET", "/api/admin/projects");
        const list = projects.filter(matches);
        el.innerHTML = list.length ? `<table><thead><tr><th>Project</th><th>Owner</th><th>Status</th><th>CPU</th><th>Memory</th><th>Uptime</th><th></th></tr></thead><tbody>
          ${list.map(p => `<tr><td>${h(p.name)}<br><span class="muted">${h(p.code)}</span></td><td>${h(p.owner || "—")}</td><td><span class="status ${p.status}">${STATUS[p.status] || h(p.status)}</span></td>
          <td>${Math.round(p.cpu)}%</td><td>${fmtMem(p.memoryMB)}</td><td>${p.status === "running" ? fmtUptime(p.uptimeSeconds) : "—"}</td>
          <td><div class="btn-row"><a class="btn sm" href="#/project/${p.id}">Open</a>${p.status === "running" ? `<button class="btn sm" data-action="a-stop" data-id="${p.id}" type="button">Stop</button>` : ""}</div></td></tr>`).join("")}</tbody></table>` : `<p class="muted">No projects found.</p>`;
      } else {
        const { entries } = await api("GET", "/api/admin/audit?limit=150");
        el.innerHTML = `<table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Target</th><th>IP</th></tr></thead><tbody>
          ${entries.map(e => `<tr><td>${fmtDate(e.createdAt)}</td><td>${h(e.username || "—")}</td><td>${h(e.action)}</td><td>${h(e.target || "")}</td><td>${h(e.ip || "")}</td></tr>`).join("")}</tbody></table>`;
      }
    } catch (error) { el.innerHTML = `<p class="muted">${h(error.message)}</p>`; }
  }

  /* ---------- settings ---------- */
  function renderSettings() {
    const u = state.user, s = state.server || {};
    $("#view").innerHTML = `
      <div class="page-head"><div><h1>Settings</h1><p>Your account and preferences.</p></div></div>
      <div class="section-gap">
        <section class="panel"><div class="panel-head"><div class="panel-title"><span class="title-icon">${icon("users")}</span><h3>Account</h3></div></div>
          <dl class="kv"><dt>Username</dt><dd>${h(u.username)}</dd><dt>Email</dt><dd>${h(u.email)}</dd><dt>Role</dt><dd>${u.role === "admin" ? "Administrator" : "User"}</dd>
          <dt>Project limit</dt><dd>${u.role === "admin" ? "Unlimited" : u.maxProjects}</dd><dt>Memory per project</dt><dd>${fmtMem(u.memoryMB)}</dd></dl></section>
        <section class="panel"><div class="panel-head"><div class="panel-title"><span class="title-icon">${icon("lock")}</span><h3>Change password</h3></div></div>
          <form id="pwForm" class="form-grid">
            <label class="field"><span>Current password</span><input type="password" id="pwCur" autocomplete="current-password" required></label>
            <label class="field"><span>New password</span><input type="password" id="pwNew" autocomplete="new-password" minlength="8" maxlength="128" required></label>
            <div class="wide btn-row"><button class="btn primary" type="submit">Update password</button></div>
          </form><div class="form-message" id="pwMsg"></div></section>
        <section class="panel"><div class="panel-head"><div class="panel-title"><span class="title-icon">${icon("moon")}</span><h3>Appearance</h3></div></div>
          <div class="btn-row"><button class="btn" data-action="theme-dark" type="button">Dark</button><button class="btn" data-action="theme-light" type="button">Light</button></div></section>
        <section class="panel"><div class="panel-head"><div class="panel-title"><span class="title-icon">${icon("servers")}</span><h3>About</h3></div></div>
          <dl class="kv"><dt>Version</dt><dd>${h(s.version || "")}</dd><dt>Runner</dt><dd>${s.runner === "docker" ? "Docker containers" : "Local processes"}</dd></dl></section>
      </div>`;
    $("#pwForm").addEventListener("submit", async e => {
      e.preventDefault();
      const msg = $("#pwMsg");
      try {
        await api("POST", "/api/auth/password", { currentPassword: $("#pwCur").value, newPassword: $("#pwNew").value });
        msg.className = "form-message success"; msg.textContent = "Password updated. Other devices were signed out.";
        $("#pwForm").reset();
      } catch (error) { msg.className = "form-message error"; msg.textContent = error.message; }
    });
  }

  /* ---------- actions ---------- */
  function closePopovers() {
    $$(".menu:not(.up)").forEach(m => { m.hidden = true; });
    $("#userMenu").hidden = true;
    $("#notifPanel").hidden = true;
  }

  async function control(id, action) {
    try {
      const data = await api("POST", `/api/projects/${id}/${action}`);
      toast(data.message, "success");
      await refreshAll();
      repaintLive();
      if (parseRoute().page === "project") refreshDetail(true);
    } catch (error) { toast(error.message, "error"); await refreshAll().catch(() => {}); repaintLive(); }
  }

  async function removeProject(id) {
    const p = state.projects.find(x => x.id === id) || state.detail;
    const ok = await confirmModal({ title: `Delete ${p ? p.name : "project"}?`, message: "This stops the project and permanently deletes its files and logs.", confirmText: "Delete", danger: true });
    if (!ok) return;
    try {
      await api("DELETE", `/api/projects/${id}`);
      toast("Project deleted", "success");
      await refreshAll();
      if (parseRoute().page === "project") location.hash = "#/projects"; else route();
    } catch (error) { toast(error.message, "error"); }
  }

  function addProjectModal() {
    openModal(`
      <h2>Add project</h2><p class="muted">Create the project first, then deploy your code.</p>
      <form id="addForm">
        <label class="field"><span>Project name</span><input type="text" id="aName" maxlength="60" required placeholder="e.g. My WhatsApp Bot"></label>
        <label class="field"><span>Runtime</span><select id="aRuntime"><option value="nodejs">Node.js</option><option value="python">Python</option></select></label>
        <label class="field"><span>Messaging platform</span><select id="aPlatform"><option value="whatsapp">WhatsApp</option><option value="telegram">Telegram</option><option value="discord">Discord</option><option value="other">Other / general app</option></select></label>
        <div class="form-message" id="aMsg"></div>
        <div class="btn-row"><button class="btn primary" type="submit">Create project</button><button class="btn" type="button" id="aCancel">Cancel</button></div>
      </form>`, m => {
      $("#aCancel", m).addEventListener("click", closeModal);
      $("#addForm", m).addEventListener("submit", async e => {
        e.preventDefault();
        try {
          const data = await api("POST", "/api/projects", { name: $("#aName").value.trim(), runtime: $("#aRuntime").value, platform: $("#aPlatform").value });
          closeModal();
          await refreshAll();
          location.hash = `#/project/${data.project.id}/deploy`;
        } catch (error) { const msg = $("#aMsg"); msg.className = "form-message error"; msg.textContent = error.message; }
      });
    });
  }

  document.addEventListener("click", async e => {
    const target = e.target.closest("[data-action], [data-tab], [data-admintab], .project");
    const insideMenu = e.target.closest(".menu, .popover, .bell-wrap, .user-card");
    if (!target) { if (!insideMenu) closePopovers(); return; }
    if (!insideMenu && target.dataset.action !== "more") closePopovers();

    if (target.dataset.tab) { location.hash = `#/project/${state.detail.id}/${target.dataset.tab}`; return; }
    if (target.dataset.admintab) { state.adminTab = target.dataset.admintab; paintAdmin(); return; }

    const { action } = target.dataset;
    const id = Number(target.dataset.id);

    if (!action) { // project card body
      if (e.target.closest(".p-actions")) return;
      const cardId = Number(target.dataset.id);
      if (parseRoute().page === "dashboard") {
        state.selectedId = cardId; syncLiveSelect(true); paintQuick();
        $$(".project").forEach(c => c.classList.toggle("selected", Number(c.dataset.id) === cardId));
        attachStream("#liveTerm", cardId, 60);
      } else location.hash = `#/project/${cardId}`;
      return;
    }

    switch (action) {
      case "start": case "stop": case "restart": return control(id, action);
      case "more": { const menu = target.nextElementSibling; const open = menu.hidden; $$(".menu:not(.up)").forEach(m => { m.hidden = true; }); menu.hidden = !open; return; }
      case "open": location.hash = `#/project/${id}`; return;
      case "open-deploy": location.hash = `#/project/${id}/deploy`; return;
      case "open-logs": location.hash = `#/project/${id}/logs`; return;
      case "delete": return removeProject(id);
      case "add": return addProjectModal();
      case "refresh": await refreshAll().catch(err => toast(err.message, "error")); toast("Refreshed"); return route();
      case "q-logs": location.hash = `#/project/${state.selectedId}/logs`; return;
      case "q-settings": location.hash = `#/project/${state.selectedId}/settings`; return;
      case "q-restart": return control(state.selectedId, "restart");
      case "q-stop": return control(state.selectedId, "stop");
      case "d-start": return control(state.detail.id, "start");
      case "d-stop": return control(state.detail.id, "stop");
      case "d-restart": return control(state.detail.id, "restart");
      case "clear-logs": {
        const pid = parseRoute().page === "project" ? state.detail.id : state.selectedId;
        if (!pid) return;
        await api("DELETE", `/api/projects/${pid}/logs`).catch(err => toast(err.message, "error"));
        const term = $("#bigTerm"); if (term) term.innerHTML = `<div class="none">Logs cleared.</div>`;
        return;
      }
      case "env-add": { const rows = $("#envRows"); rows.insertAdjacentHTML("beforeend", $("#tabBody").dataset.rowTpl); return; }
      case "env-remove": target.closest(".env-row").remove(); return;
      case "env-save": {
        const msg = $("#envMsg");
        const env = $$(".env-row").map(r => {
          const key = $(".env-key", r).value.trim(), value = $(".env-val", r).value;
          return { key, value: value === "" && r.dataset.saved === "1" ? null : value };
        }).filter(v => v.key);
        try {
          const data = await api("PUT", `/api/projects/${state.detail.id}/env`, { env });
          msg.className = "form-message success"; msg.textContent = data.message;
          paintEnv($("#tabBody"));
        } catch (error) { msg.className = "form-message error"; msg.textContent = error.message; }
        return;
      }
      case "theme-dark": return setTheme("dark");
      case "theme-light": return setTheme("light");
      case "goto-settings": location.hash = "#/settings"; return;
      case "logout": return logout();
      case "a-stop": await control(id, "stop"); return paintAdmin();
      case "u-save": case "u-role": case "u-suspend": case "u-delete": {
        const row = target.closest("tr"), uid = row.dataset.uid;
        try {
          if (action === "u-delete") {
            if (!await confirmModal({ title: "Delete this user?", message: "Their projects are stopped and permanently deleted.", confirmText: "Delete user", danger: true })) return;
            await api("DELETE", `/api/admin/users/${uid}`);
          } else {
            const body = action === "u-save"
              ? { maxProjects: Number($("[data-limit=maxProjects]", row).value), memoryMB: Number($("[data-limit=memoryMB]", row).value) }
              : action === "u-role" ? { role: target.dataset.role } : { suspended: target.dataset.on === "1" };
            await api("PATCH", `/api/admin/users/${uid}`, body);
          }
          toast("Done", "success");
          paintAdmin();
        } catch (error) { toast(error.message, "error"); }
      }
    }
  });

  /* ---------- top bar wiring ---------- */
  $("#searchInput").addEventListener("input", e => {
    state.query = e.target.value;
    const r = parseRoute();
    if (r.page === "dashboard") paintGrid($("#projectGrid"), state.projects.filter(matches).slice(0, 4));
    else if (r.page === "projects") paintGrid($("#projectGrid"), state.projects.filter(matches));
    else if (r.page === "users") paintAdmin();
  });
  $("#searchInput").addEventListener("keydown", e => {
    if (e.key === "Enter" && parseRoute().page === "dashboard" && state.query.trim()) location.hash = "#/projects";
  });
  $("#themeBtn").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  $("#menuBtn").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#scrim").hidden = false; });
  $("#scrim").addEventListener("click", () => { $("#sidebar").classList.remove("open"); $("#scrim").hidden = true; });
  $("#userBtn").addEventListener("click", () => { const m = $("#userMenu"); const open = m.hidden; closePopovers(); m.hidden = !open; });

  $("#bellBtn").addEventListener("click", async () => {
    const panel = $("#notifPanel");
    const open = panel.hidden;
    closePopovers();
    if (!open) return;
    try { state.notifs = await api("GET", "/api/notifications"); } catch { /* keep old list */ }
    panel.innerHTML = `<h4>Notifications</h4>` + (state.notifs.items.length
      ? state.notifs.items.map(n => `<div class="notif ${n.type} ${n.read ? "" : "unread"}"><i class="nd"></i><div><p>${h(n.message)}</p><small>${ago(n.createdAt)}</small></div></div>`).join("")
      : `<p class="muted notif">You're all caught up.</p>`);
    panel.hidden = false;
    if (state.notifs.unread) {
      api("POST", "/api/notifications/read").then(() => { state.notifs.unread = 0; paintBell(); }).catch(() => {});
    }
  });

  $("#view").addEventListener("change", e => {
    if (e.target.id === "liveSelect") {
      state.selectedId = Number(e.target.value);
      paintQuick();
      $$(".project").forEach(c => c.classList.toggle("selected", Number(c.dataset.id) === state.selectedId));
      attachStream("#liveTerm", state.selectedId, 60);
    }
  });

  /* ---------- boot ---------- */
  (async function init() {
    try {
      const me = await api("GET", "/api/auth/me");
      await enterApp(me.user);
    } catch {
      showAuth();
    }
  })();
})();

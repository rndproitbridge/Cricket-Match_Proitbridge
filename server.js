"use strict";
// PIB vs ZPX live cricket: serves the page and stores the score in Postgres.
// Viewers get updates over Server-Sent Events (/api/stream); only the scorer can write.
const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { Pool } = require("pg");

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const SCORER_EMAIL = (env.SCORER_EMAIL || "").trim().toLowerCase();
const SCORER_PASSWORD = env.SCORER_PASSWORD || "";
const SESSION_SECRET = env.SESSION_SECRET || "";
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || "";
const DRIVE_FOLDER_NAME = env.DRIVE_FOLDER_NAME || "PIB vs ZPX Cricket 2026 – Scorecards";
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_MAX_FAILS = 10;

const missing = [];
if (!SCORER_EMAIL) missing.push("SCORER_EMAIL");
if (!SCORER_PASSWORD) missing.push("SCORER_PASSWORD");
if (SESSION_SECRET.length < 32) missing.push("SESSION_SECRET (at least 32 characters)");
if (missing.length) { console.error("Missing settings: " + missing.join(", ")); process.exit(1); }

/* ---------- database ---------- */
// Connection settings come from DATABASE_URL, or the standard PGHOST/PGUSER/PGPASSWORD/PGDATABASE variables.
const pool = new Pool(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {});
pool.on("error", err => console.error("Postgres pool error:", err.message));

async function waitForDb() {
  for (let i = 1; ; i++) {
    try { await pool.query("SELECT 1"); return; }
    catch (err) {
      if (i >= 30) throw err;
      console.log(`Waiting for Postgres (${err.message})`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id         text PRIMARY KEY,
      data       jsonb NOT NULL,
      rev        bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS results (
      id       text PRIMARY KEY,
      data     jsonb NOT NULL,
      saved_at timestamptz NOT NULL DEFAULT now()
    );`);
}
// documents: "live" (the match being scored) and "drive" (the Google Drive scorecards folder)
async function getDoc(id) {
  const { rows } = await pool.query("SELECT data, rev FROM documents WHERE id = $1", [id]);
  return rows[0] ? { data: rows[0].data, rev: Number(rows[0].rev) } : { data: null, rev: 0 };
}
async function putDoc(id, data) {
  const { rows } = await pool.query(
    `INSERT INTO documents (id, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, rev = documents.rev + 1, updated_at = now()
     RETURNING rev`, [id, JSON.stringify(data)]);
  return Number(rows[0].rev);
}
async function listResults() {
  const { rows } = await pool.query("SELECT id, data FROM results ORDER BY saved_at");
  return rows.map(r => ({ ...r.data, _id: r.id }));
}

/* ---------- scorer login ---------- */
// Tokens are signed with the secret and the password, so changing either logs every device out.
const hash = s => crypto.createHash("sha256").update(String(s)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
const sign = s => crypto.createHmac("sha256", SESSION_SECRET + "\0" + SCORER_PASSWORD).update(s).digest("base64url");
function issueToken() {
  const p = Buffer.from(JSON.stringify({ e: SCORER_EMAIL, x: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  return p + "." + sign(p);
}
function readToken(req) {
  const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  if (!m) return null;
  const [p, s] = m[1].split(".");
  if (!p || !s || !sameText(s, sign(p))) return null;
  try {
    const t = JSON.parse(Buffer.from(p, "base64url").toString());
    return t.e === SCORER_EMAIL && t.x > Date.now() ? t.e : null;
  } catch { return null; }
}
const requireScorer = (req, res, next) => readToken(req) ? next() : res.status(401).json({ error: "Log in as the scorer." });
const failures = new Map(); // ip -> { n, until }
function noteFailure(ip) {
  const now = Date.now();
  if (failures.size > 1000) for (const [k, v] of failures) if (v.until <= now) failures.delete(k);
  const f = failures.get(ip);
  const cur = f && f.until > now ? f : { n: 0, until: now + LOGIN_WINDOW_MS };
  cur.n++; failures.set(ip, cur);
}

/* ---------- live updates ---------- */
const clients = new Set();
function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
const ping = setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000);

/* ---------- routes ---------- */
const app = express();
app.set("trust proxy", 1); // Traefik (Dokploy) sits in front
app.disable("x-powered-by");
app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); next(); });
app.use("/api", express.json({ limit: "2mb" }));
const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const needObject = (req, res, next) => isObject(req.body) ? next() : res.status(400).json({ error: "Expected a JSON object." });

app.get("/healthz", async (req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});
app.get("/config.js", (req, res) => {
  res.type("application/javascript").set("Cache-Control", "no-store")
    .send(`window.GOOGLE_CLIENT_ID=${JSON.stringify(GOOGLE_CLIENT_ID)};\nwindow.DRIVE_FOLDER_NAME=${JSON.stringify(DRIVE_FOLDER_NAME)};\n`);
});

app.post("/api/login", (req, res) => {
  const f = failures.get(req.ip);
  if (f && f.n >= LOGIN_MAX_FAILS && f.until > Date.now()) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  const { email, password } = req.body || {};
  const okEmail = sameText(String(email || "").trim().toLowerCase(), SCORER_EMAIL);
  const okPass = sameText(String(password || ""), SCORER_PASSWORD);
  if (!(okEmail && okPass)) { noteFailure(req.ip); return res.status(401).json({ error: "Wrong email or password." }); }
  failures.delete(req.ip);
  res.json({ token: issueToken(), email: SCORER_EMAIL });
});
app.get("/api/me", (req, res) => {
  const email = readToken(req);
  email ? res.json({ email }) : res.status(401).json({ error: "Not logged in." });
});

app.get("/api/stream", async (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
  try {
    const [live, results, drive] = await Promise.all([getDoc("live"), listResults(), getDoc("drive")]);
    res.write(`event: state\ndata: ${JSON.stringify({ live, results, drive: drive.data })}\n\n`);
  } catch (err) {
    console.error("Stream snapshot failed:", err.message);
    clients.delete(res); res.end(); // the browser reconnects on its own
  }
});

app.put("/api/live", requireScorer, needObject, async (req, res) => {
  const rev = await putDoc("live", req.body);
  broadcast("live", { data: req.body, rev });
  res.json({ rev });
});
app.post("/api/results", requireScorer, needObject, async (req, res) => {
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO results (id, data) VALUES ($1, $2::jsonb)", [id, JSON.stringify(req.body)]);
  broadcast("results", await listResults());
  res.status(201).json({ id });
});
app.patch("/api/results/:id", requireScorer, needObject, async (req, res) => {
  const { rowCount } = await pool.query("UPDATE results SET data = data || $2::jsonb WHERE id = $1", [req.params.id, JSON.stringify(req.body)]);
  if (!rowCount) return res.status(404).json({ error: "No such result." });
  broadcast("results", await listResults());
  res.json({ ok: true });
});
app.get("/api/config/drive", async (req, res) => res.json((await getDoc("drive")).data || {}));
app.put("/api/config/drive", requireScorer, needObject, async (req, res) => {
  await putDoc("drive", req.body);
  broadcast("drive", req.body);
  res.json({ ok: true });
});
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

app.use(express.static(path.join(__dirname, "public"), { setHeaders: res => res.set("Cache-Control", "no-cache") }));

app.use((err, req, res, next) => {
  if (!err.expose) console.error(err);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: err.expose ? err.message : "Server error." });
});

/* ---------- start ---------- */
async function main() {
  await waitForDb();
  await migrate();
  const server = app.listen(PORT, () => console.log(`Cricket live listening on :${PORT}`));
  const stop = () => {
    console.log("Shutting down");
    clearInterval(ping);
    for (const res of clients) res.end();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
main().catch(err => { console.error("Startup failed:", err); process.exit(1); });

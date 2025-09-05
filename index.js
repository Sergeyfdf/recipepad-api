import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import bcrypt from "bcryptjs";
import { Pool } from "pg";

const app = express();
const PORT = process.env.PORT || 8080;

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const SESSION_KEYS = (process.env.SESSION_KEYS || "dev_key1,dev_key2").split(",");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // для Neon/Render
});

// ---------- CORS + body ----------
app.use(cors({
  origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN, // можно true для dev
  credentials: true, // чтобы куки ходили
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"],
}));
app.use(express.json({ limit: "10mb" }));

// ---------- Cookie session ----------
app.use(cookieSession({
  name: "sid",
  keys: SESSION_KEYS,
  httpOnly: true,
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней
  secure: process.env.NODE_ENV === "production",     // на проде только https
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
}));

// ---------- DB: ensure schema ----------
async function ensureSchema() {
  // расширение для gen_random_uuid
  await pool.query(`create extension if not exists pgcrypto;`);

  // пользователи
  await pool.query(`
    create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      username text not null unique,
      password_hash text not null,
      role text not null default 'user',
      created_at timestamptz not null default now()
    );
  `);

  // рецепты (id как у фронта; сам рецепт — в jsonb)
  await pool.query(`
    create table if not exists recipes (
      id text primary key,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  // триггер для updated_at
  await pool.query(`
    create or replace function set_updated_at() returns trigger as $$
    begin
      new.updated_at = now();
      return new;
    end $$ language plpgsql;

    drop trigger if exists tr_set_updated_at on recipes;
    create trigger tr_set_updated_at
    before update on recipes
    for each row execute procedure set_updated_at();
  `);
}
ensureSchema().catch((e) => console.error("ensureSchema error:", e));

// ---------- helpers ----------
async function getSessionUser(req) {
  const uid = req.session?.userId;
  if (!uid) return null;
  const { rows } = await pool.query(
    "select id, username, role from users where id=$1",
    [uid]
  );
  return rows[0] || null;
}
function requireAuth() {
  return async (req, res, next) => {
    const me = await getSessionUser(req);
    if (!me) return res.status(401).json({ error: "unauthorized" });
    req.user = me;
    next();
  };
}

// ---------- health ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- AUTH ----------
app.post("/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password || String(password).length < 4) {
      return res.status(400).json({ error: "bad input" });
    }
    const uname = String(username).trim().toLowerCase();

    const exists = await pool.query("select 1 from users where username=$1", [uname]);
    if (exists.rowCount) return res.status(409).json({ error: "username taken" });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      "insert into users (username, password_hash) values ($1,$2) returning id, username, role",
      [uname, hash]
    );
    const user = rows[0];
    req.session.userId = user.id; // логиним сразу
    res.json({ user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "bad input" });

    const uname = String(username).trim().toLowerCase();
    const { rows } = await pool.query(
      "select id, username, role, password_hash from users where username=$1",
      [uname]
    );
    if (!rows.length) return res.status(401).json({ error: "invalid credentials" });

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: "invalid credentials" });

    req.session.userId = rows[0].id;
    res.json({ user: { id: rows[0].id, username: rows[0].username, role: rows[0].role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/auth/me", async (req, res) => {
  try {
    const me = await getSessionUser(req);
    if (!me) return res.status(401).json({ user: null });
    res.json({ user: me });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session = null; // очищаем куку
  res.status(204).end();
});

// ---------- RECIPES API ----------

// список (отдаём массив твоих Recipe из data; сортируем по updated_at)
app.get("/recipes", async (_req, res) => {
  const { rows } = await pool.query(
    "select id, data from recipes order by updated_at desc"
  );
  res.json(rows.map(r => ({ ...r.data, id: r.id })));
});

// один рецепт
app.get("/recipes/:id", async (req, res) => {
  const { rows } = await pool.query(
    "select id, data from recipes where id=$1",
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "not found" });
  res.json({ ...rows[0].data, id: rows[0].id });
});

// выложить/обновить (upsert). Если хочешь — повесь requireAuth()
app.put("/recipes/:id", /* requireAuth(), */ async (req, res) => {
  const recipe = req.body?.recipe;
  if (!recipe || typeof recipe !== "object") {
    return res.status(400).json({ error: "body.recipe required" });
  }
  await pool.query(
    `insert into recipes (id, data) values ($1, $2)
     on conflict (id) do update set data=excluded.data`,
    [req.params.id, recipe]
  );
  res.json({ ok: true });
});

// удалить
app.delete("/recipes/:id", /* requireAuth(), */ async (req, res) => {
  await pool.query("delete from recipes where id=$1", [req.params.id]);
  res.status(204).end();
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log("API listening on", PORT);
});

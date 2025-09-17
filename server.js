import express from "express";
import cors from "cors";
import compression from "compression";
import { Pool } from "pg";
import dns from "dns";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { Telegraf, Markup } from "telegraf";
import cookieParser from "cookie-parser";

// чтобы на Render/Neon не было проблем с IPv6
dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  "https://sergeyfdf.github.io",
  "http://localhost:5173",
  "http://localhost:3000",
];

app.use(
  cors({
    origin(origin, cb) {
      // Разрешаем и curl/серверные запросы без Origin
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Owner-Id",
      "Cache-Control",
      "If-None-Match",
      "If-Modified-Since",
    ],
    exposedHeaders: ["ETag", "Last-Modified"],
    maxAge: 600,
    credentials: true, // куки и auth-заголовки
  })
);

// Быстрые preflight-ответы на любые пути
app.options("*", cors());

app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));

// ---------- БАЗА ДАННЫХ ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // postgres://user:pass@host/db?sslmode=require
  ssl: { rejectUnauthorized: false }, // для Neon/Render
});



function signJwtForTelegram(tg_id) {
  const jwtSecret = process.env.JWT_SECRET || "dev-secret";
  return jwt.sign({ sub: `tg:${tg_id}`, tg_id }, jwtSecret, { expiresIn: "90d" });
}

async function upsertUserRow({ tg_id, username, first_name, last_name, photo_url }) {
  const clean = (x) =>
    typeof x === "string"
      ? x.replace(/[\p{C}\uFFFE\uFFFF]/gu, "").trim() || null
      : null;

  await pool.query(
    `INSERT INTO public.users (tg_id, username, first_name, last_name, photo_url)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT ON CONSTRAINT users_tg_id_key
     DO UPDATE SET
       username   = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       last_name  = EXCLUDED.last_name,
       photo_url  = EXCLUDED.photo_url,
       last_login = now()`,
    [tg_id, clean(username), clean(first_name), clean(last_name), clean(photo_url)]
  );
}


// ========================= SCHEMA =========================
async function ensureUsersSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.users (
      tg_id      text PRIMARY KEY,
      username   text,
      first_name text,
      last_name  text,
      photo_url  text,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_login timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tg_id      text;`);
  await pool.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username   text;`);
  await pool.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS first_name text;`);
  await pool.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_name  text;`);
  await pool.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS photo_url  text;`);
  await pool.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();`);
  await pool.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_login timestamptz NOT NULL DEFAULT now();`);
  await pool.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS bot_enabled boolean NOT NULL DEFAULT true;`);
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='users'
          AND column_name='password_hash' AND is_nullable='NO'
      ) THEN
        EXECUTE 'ALTER TABLE public.users ALTER COLUMN password_hash DROP NOT NULL';
      END IF;
    END$$;
  `);

  // убрать пустые tg_id и дубликаты
  await pool.query(`DELETE FROM public.users WHERE tg_id IS NULL OR tg_id = ''`);
  await pool.query(`
    DELETE FROM public.users u
    USING public.users d
    WHERE u.tg_id = d.tg_id AND u.ctid > d.ctid;
  `);

  // гарантируем уникальность tg_id (достаточно для ON CONFLICT)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid='public.users'::regclass
          AND conname='users_tg_id_key'
      ) THEN
        ALTER TABLE public.users ADD CONSTRAINT users_tg_id_key UNIQUE (tg_id);
      END IF;
    END$$;
  `);
}

// вызов в инициализации:
ensureUsersSchema().catch(err => {
  console.error("ensureUsersSchema error:", err);
});







async function ensureSchema() {
  await pool.query(`
    -- Глобальные (опубликованные) рецепты
    create table if not exists recipes (
      id         text primary key,
      data       jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    -- Личные рецепты (по владельцу owner = telegram id)
    create table if not exists local_recipes (
      owner      text not null,
      id         text not null,
      data       jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (owner, id)
    );

    -- Пользователи Telegram
    create table if not exists users (
      tg_id      text primary key,
      username   text,
      first_name text,
      last_name  text,
      photo_url  text,
      created_at timestamptz not null default now(),
      last_login timestamptz not null default now()
    );

    -- updated_at триггер
    create or replace function touch_updated_at() returns trigger as $$
    begin
      new.updated_at = now();
      return new;
    end $$ language plpgsql;

    drop trigger if exists tr_touch_updated_at_recipes on recipes;
    create trigger tr_touch_updated_at_recipes
      before update on recipes
      for each row execute procedure touch_updated_at();

    drop trigger if exists tr_touch_updated_at_local_recipes on local_recipes;
    create trigger tr_touch_updated_at_local_recipes
      before update on local_recipes
      for each row execute procedure touch_updated_at();

    create index if not exists idx_recipes_updated_at on recipes (updated_at desc);
    create index if not exists idx_local_recipes_updated_at on local_recipes (updated_at desc);
  `);
}
ensureSchema().catch((err) => {
  console.error("ensureSchema error:", err);
});


// ========================= UTILS =========================
function normStr(x) {
  if (typeof x !== "string") return null;
  const cleaned = x.replace(/[\u0000-\u001F\u007F\uFFFE\uFFFF]/g, "").trim();
  return cleaned.length ? cleaned : null;
}

function getOwner(req) {
  // фронт шлёт X-Owner-Id, оставляем как источник истины
  return String(req.header("X-Owner-Id") || req.query.owner || "").trim();
}

function requireAuth(req, res, next) {
  try {
    const h = String(req.headers.authorization || "");
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "no_token" });
    const token = m[1];
    const jwtSecret = process.env.JWT_SECRET || "dev-secret";
    const payload = jwt.verify(token, jwtSecret);
    req.user = payload; // { sub: "tg:<id>", tg_id: "<id>" }
    next();
  } catch (e) {
    return res.status(401).json({ error: "bad_token" });
  }
}

// ========================= HEALTH =========================
app.get("/health", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// =====================================================================
// =========================== TELEGRAM AUTH ============================
// =====================================================================
const TG_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;

if (!TG_BOT_TOKEN) {
  console.warn(
    "TELEGRAM_BOT_TOKEN is not set — /auth/telegram* будет отклонять запросы."
  );
}

// Универсальная проверка подписи Telegram (поддержка 2 форматов):
// 1) Виджет Web Login: поля id, first_name, username, photo_url, auth_date, hash
// 2) WebApp initData: поля user (строка JSON), auth_date, hash
function verifyTelegramAuth(payload) {
  try {
    if (!TG_BOT_TOKEN) return false;
    if (!payload || typeof payload !== "object") return false;

    const receivedHash = String(payload.hash || "");
    if (!receivedHash) return false;

    // Сформируем "data_check_string"
    // Особый случай: если есть ключ "user" и он объект — он должен быть СТРОКОЙ (minified JSON)
    const entries = Object.entries(payload)
      .filter(([k]) => k !== "hash")
      .map(([k, v]) => {
        if (k === "user") {
          if (typeof v === "string") return [k, v];
          try {
            return [k, JSON.stringify(v)];
          } catch {
            return [k, String(v)];
          }
        }
        return [k, String(v)];
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    // secret_key = sha256(bot_token)
    const secretKey = crypto
      .createHash("sha256")
      .update(TG_BOT_TOKEN)
      .digest();

    const hmac = crypto
      .createHmac("sha256", secretKey)
      .update(entries)
      .digest("hex");

    if (hmac !== receivedHash.toLowerCase()) return false;

    // Проверка "свежести"
    const authDate = Number(payload.auth_date || 0);
    if (authDate > 0) {
      const now = Math.floor(Date.now() / 1000);
      const age = now - authDate;
      if (age > 24 * 3600) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ----- 1) Твой существующий JSON-логин (/auth/telegram) -----
app.post("/auth/telegram", async (req, res) => {
  try {
    const data = req.body || {};

    if (!verifyTelegramAuth(data)) {
      return res.status(403).json({ error: "bad_signature" });
    }

    const tg_id = String(data.id);
    const username = normStr(data.username);
    const first_name = normStr(data.first_name);
    const last_name = normStr(data.last_name);
    const photo_url = normStr(data.photo_url);

    await upsertUserRow({ tg_id, username, first_name, last_name, photo_url });

    const token = signJwtForTelegram(tg_id);

    // Поставим httpOnly cookie (можешь не использовать на фронте)
    res.cookie("rp_jwt", token, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 90 * 24 * 3600 * 1000,
    });

    res.json({
      ok: true,
      jwt: token,
      ownerId: `tg:${tg_id}`,
      profile: { username, first_name, last_name, photo_url },
    });
  } catch (e) {
    console.error("/auth/telegram error:", e);
    res.status(500).json({ error: "internal" });
  }
});

// ----- 2) Callback ДЛЯ ВИДЖЕТА (GET) -----
app.get("/auth/telegram/callback", async (req, res) => {
  try {
    // В query могут прийти либо топ-поля (id, first_name, ...)
    // либо user=<json>&auth_date&hash
    // Для верификации нам важны ОРИГИНАЛЬНЫЕ строки, поэтому юзера не парсим до сверки
    const q = Object.fromEntries(
      Object.entries(req.query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
    );

    if (!verifyTelegramAuth(q)) {
      return res.status(401).send("invalid_signature");
    }

    // Теперь можно собрать профиль
    let user;
    if (q.user) {
      try {
        user = JSON.parse(q.user);
      } catch {
        user = null;
      }
    } else {
      user = {
        id: Number(q.id),
        first_name: q.first_name,
        last_name: q.last_name,
        username: q.username,
        photo_url: q.photo_url,
      };
    }

    const tg_id = String(user?.id || "");
    if (!tg_id) return res.status(400).send("no_user");

    // upsert user
    await upsertUserRow({
      tg_id,
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
      photo_url: user.photo_url,
    });

    const token = signJwtForTelegram(tg_id);
    res.cookie("rp_jwt", token, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 90 * 24 * 3600 * 1000,
    });

    // Редиректим обратно на фронт (можешь поменять URL)
    const redirect = process.env.AUTH_REDIRECT || "https://sergeyfdf.github.io/";
    return res.redirect(302, redirect);
  } catch (e) {
    console.error("GET /auth/telegram/callback error:", e);
    return res.status(500).send("internal");
  }
});

// ----- 3) Callback ДЛЯ FETCH(JSON) (POST) -----
app.post("/auth/telegram/callback", async (req, res) => {
  try {
    if (!TG_BOT_TOKEN) {
      return res.status(500).json({ error: "bot_token_missing" });
    }

    const body = req.body || {};

    // Готовим payload для проверки подписи (user должен быть строкой)
    const toVerify = { ...body };
    if (toVerify.user && typeof toVerify.user !== "string") {
      try { toVerify.user = JSON.stringify(toVerify.user); } catch {}
    }
    if (!toVerify.hash || !toVerify.auth_date) {
      return res.status(400).json({ error: "bad_payload", details: "no hash/auth_date" });
    }
    if (!verifyTelegramAuth(toVerify)) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    // Собираем профиль
    let user = body.user;
    if (typeof user === "string") {
      try { user = JSON.parse(user); } catch { user = null; }
    }
    if (!user) {
      user = {
        id: Number(body.id),
        first_name: body.first_name,
        last_name: body.last_name,
        username: body.username,
        photo_url: body.photo_url,
      };
    }

    const tg_id = String(user?.id || "");
    if (!tg_id) return res.status(400).json({ error: "no_user" });

    // Единственный UPSERT пользователя
    await upsertUserRow({
      tg_id,
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
      photo_url: user.photo_url,
    });

    // JWT
    const token = signJwtForTelegram(tg_id);

    // httpOnly cookie (если будешь использовать куки)
    res.cookie("rp_jwt", token, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: 90 * 24 * 3600 * 1000,
    });

    // Отдаём и user, и profile (алиас), и token для совместимости
    return res.json({
      ok: true,
      ownerId: `tg:${tg_id}`,
      user,
      profile: {
        username: user.username ?? null,
        first_name: user.first_name ?? null,
        last_name: user.last_name ?? null,
        photo_url: user.photo_url ?? null,
      },
      jwt: token,
      token, // алиас на всякий случай
    });
  } catch (e) {
    console.error("POST /auth/telegram/callback fatal:", e);
    return res.status(500).json({ error: "internal", details: String(e?.message || e) });
  }
});

app.post("/auth/telegram/link", requireAuth, async (req, res) => {
  try {
    await pool.query(`update users set bot_enabled=true where tg_id=$1`, [String(req.user.tg_id)]);
    res.json({ ok: true });
  } catch (e) {
    console.error("link bot failed", e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/auth/telegram/unlink", requireAuth, async (req, res) => {
  try {
    await pool.query(`update users set bot_enabled=false where tg_id=$1`, [String(req.user.tg_id)]);
    res.json({ ok: true });
  } catch (e) {
    console.error("unlink bot failed", e);
    res.status(500).json({ error: "internal" });
  }
});


// ----- 4) СЕССИЯ -----
app.get("/auth/session/me", requireAuth, async (req, res) => {
  try {
    const tgId = String(req.user?.tg_id || "");
    if (!tgId) return res.status(401).json({ error: "bad_token" });

    const { rows } = await pool.query(
      `select tg_id, username, first_name, last_name, photo_url from users where tg_id=$1`,
      [tgId]
    );

    const row = rows[0] || {};
    return res.json({
      ownerId: `tg:${tgId}`,
      user: {
        id: Number(tgId),
        username: row.username || null,
        first_name: row.first_name || null,
        last_name: row.last_name || null,
        photo_url: row.photo_url || null,
      },
    });
  } catch (e) {
    console.error("/auth/session/me error:", e);
    return res.status(500).json({ error: "internal" });
  }
});

// =====================================================================
// =============== ГЛОБАЛЬНЫЕ РЕЦЕПТЫ (публикуемые) ====================
// =====================================================================

// список (без кэша, проще и понятнее)
app.get("/recipes", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "select id, data, updated_at from recipes order by updated_at desc"
    );
    const payload = rows.map((r) => ({ ...r.data, id: r.id }));
    res.set("Cache-Control", "no-store");
    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// один
app.get("/recipes/:id", async (req, res) => {
  const { rows } = await pool.query(
    "select id, data from recipes where id=$1",
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "not found" });
  res.set("Cache-Control", "no-store");
  res.json({ ...rows[0].data, id: rows[0].id });
});

// upsert (выложить/обновить)
app.put("/recipes/:id", async (req, res) => {
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
app.delete("/recipes/:id", async (req, res) => {
  await pool.query("delete from recipes where id=$1", [req.params.id]);
  res.status(204).end();
});

// exists
app.get("/recipes/:id/exists", async (req, res) => {
  const { rows } = await pool.query("select 1 from recipes where id=$1 limit 1", [
    req.params.id,
  ]);
  res.json({ exists: rows.length > 0 });
});

// =====================================================================
// =============== ЛОКАЛЬНЫЕ РЕЦЕПТЫ (по владельцу) ====================
// =====================================================================

// список локальных рецептов владельца
app.get("/local/recipes", async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(400).json({ error: "owner required" });

  const { rows } = await pool.query(
    "select id, data from local_recipes where owner=$1 order by updated_at desc",
    [owner]
  );
  res.set("Cache-Control", "no-store");
  res.json(rows.map((r) => ({ ...r.data, id: r.id })));
});

// один
app.get("/local/recipes/:id", async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(400).json({ error: "owner required" });

  const { rows } = await pool.query(
    "select id, data from local_recipes where owner=$1 and id=$2",
    [owner, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "not found" });
  res.json({ ...rows[0].data, id: rows[0].id });
});

// upsert
app.put("/local/recipes/:id", async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(400).json({ error: "owner required" });

  const recipe = req.body?.recipe;
  if (!recipe || typeof recipe !== "object") {
    return res.status(400).json({ error: "body.recipe required" });
  }
  const data = { ...recipe, id: req.params.id };

  await pool.query(
    `insert into local_recipes (owner, id, data) values ($1,$2,$3)
     on conflict (owner, id)
     do update set data=excluded.data, updated_at=now()`,
    [owner, req.params.id, data]
  );

  res.json({ ok: true });
});

// удалить локальный рецепт
app.delete("/local/recipes/:id", async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(400).json({ error: "owner required" });

  await pool.query("delete from local_recipes where owner=$1 and id=$2", [
    owner,
    req.params.id,
  ]);
  res.status(204).end();
});

// массовая загрузка локальных рецептов
app.post("/local/recipes/bulk", async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(400).json({ error: "owner required" });

  const arr = Array.isArray(req.body?.recipes) ? req.body.recipes : [];
  if (!arr.length) return res.json({ ok: true, count: 0 });

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local synchronous_commit = off");

    await client.query(
      `
      with src as (
        select (x->>'id')::text as id, x as data
        from jsonb_array_elements($1::jsonb) as x
      )
      insert into local_recipes (owner, id, data)
      select $2, id, data from src
      on conflict (owner, id) do update set data = excluded.data
      `,
      [JSON.stringify(arr), owner]
    );

    await client.query("commit");
    res.json({ ok: true, count: arr.length });
  } catch (e) {
    await client.query("rollback");
    console.error(e);
    res.status(500).json({ error: "internal" });
  } finally {
    client.release();
  }
});

// миграция владельца (требует Bearer JWT)
app.post("/local/recipes/migrate", requireAuth, async (req, res) => {
  const to = `tg:${req.user.tg_id}`;
  const from = String(req.body?.from || "").trim();
  if (!from || from === to) {
    return res.status(400).json({ error: "bad_params" });
    }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `
      insert into local_recipes (owner, id, data, created_at, updated_at)
      select $2 as owner, id, data, created_at, updated_at
      from local_recipes
      where owner = $1
      on conflict (owner, id)
      do update set data = excluded.data, updated_at = excluded.updated_at
      `,
      [from, to]
    );
    await client.query(`delete from local_recipes where owner=$1`, [from]);
    await client.query("commit");
    return res.json({ ok: true, from, to });
  } catch (e) {
    await client.query("rollback");
    console.error("migrate error", e);
    return res.status(500).json({ error: "internal" });
  } finally {
    client.release();
  }
});

// =====================================================================
// ========================== ЗАКАЗЫ (Telegram) =========================
// =====================================================================

app.post("/orders", async (req, res) => {
  try {
    const BOT = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    const CHAT = process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID;
    if (!BOT || !CHAT) {
      return res
        .status(500)
        .json({ error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set" });
    }

    const { title } = req.body ?? {};
    if (!title || typeof title !== "string" || title.trim().length < 2) {
      return res.status(400).json({ error: "title is required" });
    }

    const text =
      `📦 НОВЫЙ ЗАКАЗ ИЗ RECIPEPAD!\n\n` +
      `🍳 Блюдо: ${title}\n` +
      `⏰ Время: ${new Date().toLocaleString("uk-UA", {
        timeZone: "Europe/Kyiv",
      })}\n` +
      `📱 Отправлено с сайта`;

    const r = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text }),
    });
    const j = await r.json().catch(async () => ({ raw: await r.text() }));
    if (!r.ok || j?.ok === false) {
      console.warn("telegram_failed", { http: r.status, j });
      return res.status(502).json({ error: "telegram_failed" });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("orders handler error", String(e));
    return res.status(500).json({ error: "internal" });
  }
});

// быстрая проверка токена бота
app.get("/debug/tg", async (_req, res) => {
  const BOT = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;
  if (!BOT) return res.status(500).json({ error: "no BOT token" });
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT}/getMe`);
    const j = await r.json();
    res.json({ http: r.status, body: j });
  } catch (e) {
    res.status(500).json({ error: "fetch_failed", details: String(e) });
  }
});


// =====================================================================
// =========================== TELEGRAM BOT =============================
// =====================================================================
async function startBot() {
  const BOT = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;
  if (!BOT) {
    console.warn("TELEGRAM_BOT_TOKEN is not set — bot is disabled.");
    return;
  }

  const bot = new Telegraf(BOT);

  // лог ошибок telegraf-хэндлеров
  bot.catch((err, ctx) => {
    console.error("Telegraf error on", ctx?.updateType, err);
  });

  // доступ: разрешаем только если в users.bot_enabled != false
  bot.use(async (ctx, next) => {
    try {
      if (!ctx.from) return; // пропускаем сервисные апдейты
      const tgId = String(ctx.from.id);
      const { rows } = await pool.query(
        `select bot_enabled from users where tg_id=$1`,
        [tgId]
      );
      const allowed = rows.length ? rows[0].bot_enabled !== false : true; // по умолчанию true
      if (!allowed) {
        await ctx.reply(
          "Ваш Telegram отвязан от веб-аккаунта.\n" +
          "Зайдите на сайт и включите «Доступ бота», чтобы снова открыть рецепты."
        );
        return; // не пускаем дальше
      }
    } catch (e) {
      console.error("bot access check failed:", e);
      try { await ctx.reply("Временная ошибка доступа."); } catch {}
      return;
    }
    return next();
  });

  // быстрая диагностика
  bot.command("ping", (ctx) => ctx.reply("pong ✅"));

  const PAGE_SIZE = 5;

  // ===== helpers =====
  async function getPublishedSet(owner) {
    const { rows } = await pool.query(
      `select lr.id
         from local_recipes lr
         join recipes r on r.id = lr.id
        where lr.owner = $1`,
      [owner]
    );
    return new Set(rows.map(r => r.id));
  }

  function escapeMd(s = "") {
    return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
  }

  function normalizeForGlobal(rec) {
    const base = {
      id: rec.id,
      title: rec.title,
      description: rec.description || "",
      cover: rec.cover,
      createdAt: rec.createdAt || Date.now(),
      favorite: !!rec.favorite,
      categories: rec.categories || [],
      done: !!rec.done,
      parts: Array.isArray(rec.parts) ? rec.parts : [],
      ingredients: [],
      steps: [],
    };
    if (!Array.isArray(rec.parts) || rec.parts.length === 0) {
      base.ingredients = Array.isArray(rec.ingredients) ? rec.ingredients : [];
      base.steps = Array.isArray(rec.steps) ? rec.steps : [];
    }
    return base;
  }

  const badgeTitle = (title, isPublished) =>
    (isPublished ? `${title} · 🌐` : title);

  // ===== /start =====
  bot.start(async (ctx) => {
    try {
      const owner = `tg:${ctx.from.id}`;
      const totalRow = (await pool.query(
        `select count(*)::int as c from local_recipes where owner=$1`,
        [owner]
      )).rows[0] || { c: 0 };

      const pubRow = (await pool.query(
        `select count(*)::int as c
           from local_recipes lr
           join recipes r on r.id = lr.id
          where lr.owner=$1`,
        [owner]
      )).rows[0] || { c: 0 };

      const total = totalRow.c || 0;
      const published = pubRow.c || 0;

      await ctx.reply(
        `Привет, ${escapeMd(ctx.from.first_name || "друг")}!\n` +
        `У тебя *${total}* рецепт(ов), из них *${published}* выложено 🌐.\n` +
        `Нажми, чтобы посмотреть список.`,
        Markup.inlineKeyboard([[Markup.button.callback("Мои рецепты", "LIST:0")]])
      );
    } catch (e) {
      console.error("/start failed:", e);
      await ctx.reply("Что-то пошло не так. Попробуйте ещё раз позже.");
    }
  });

  // ===== список =====
  bot.action(/LIST:(\d+)/, async (ctx) => {
    try {
      const page = Number(ctx.match[1] || 0);
      const owner = `tg:${ctx.from.id}`;

      const { rows } = await pool.query(
        `select id, data from local_recipes
          where owner=$1
          order by updated_at desc`,
        [owner]
      );

      const publishedSet = await getPublishedSet(owner);
      const total = rows.length;
      const from = page * PAGE_SIZE;
      const slice = rows.slice(from, from + PAGE_SIZE);

      const buttons = slice.map((r) => [
        Markup.button.callback(
          badgeTitle(r.data?.title || r.id, publishedSet.has(r.id)),
          `OPEN:${r.id}:${page}`
        ),
      ]);

      const nav = [];
      if (page > 0) nav.push(Markup.button.callback("« Назад", `LIST:${page - 1}`));
      if (from + PAGE_SIZE < total) nav.push(Markup.button.callback("Вперёд »", `LIST:${page + 1}`));
      if (nav.length) buttons.push(nav);

      const pubCount = publishedSet.size;
      await ctx.editMessageText(
        `Мои рецепты (стр. ${page + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))})\n` +
        `Выложено: ${pubCount} из ${total} 🌐`,
        Markup.inlineKeyboard(buttons)
      );
    } catch (e) {
      console.error("LIST action error:", e);
      try { await ctx.answerCbQuery("Ошибка"); } catch {}
    }
  });

  // ===== открыть карточку =====
  bot.action(/OPEN:([^:]+):(\d+)/, async (ctx) => {
    try {
      const id = ctx.match[1];
      const page = Number(ctx.match[2] || 0);
      const owner = `tg:${ctx.from.id}`;

      const { rows } = await pool.query(
        `select data from local_recipes where owner=$1 and id=$2`,
        [owner, id]
      );
      if (!rows.length) return ctx.answerCbQuery("Не найдено");

      const r = rows[0].data || {};
      const isPublished = (await getPublishedSet(owner)).has(id);

      const title = r.title || "Без названия";
      const ingredients =
        (Array.isArray(r.parts) && r.parts.length
          ? r.parts.flatMap((p) => p.ingredients)
          : r.ingredients) || [];
      const steps =
        (Array.isArray(r.parts) && r.parts.length
          ? r.parts.flatMap((p) => p.steps)
          : r.steps) || [];

      const text =
        `*${escapeMd(title)}*\n` +
        (isPublished ? "🌐 *Выложено в глобал*\n" : "Локально\n") +
        (r.description ? `\n${escapeMd(r.description)}\n` : "") +
        (ingredients.length
          ? `\n*Ингредиенты:*\n• ${escapeMd(ingredients.join("\n• "))}\n`
          : "") +
        (steps.length
          ? `\n*Шаги:*\n${escapeMd(steps.map((s, i) => `${i + 1}. ${s}`).join("\n"))}\n`
          : "");

      const kbRows = [];
      if (isPublished) {
        kbRows.push([Markup.button.callback("🗑 Удалить из глобала", `UNPUB:${id}:${page}`)]);
      } else {
        kbRows.push([Markup.button.callback("📤 Выложить в глобал", `PUB:${id}:${page}`)]);
      }
      kbRows.push([Markup.button.callback("← К списку", `LIST:${page}`)]);
      const kb = Markup.inlineKeyboard(kbRows);

      if (r.cover && /^https?:\/\//i.test(r.cover)) {
        await ctx.replyWithPhoto(r.cover, {
          caption: text,
          parse_mode: "Markdown",
          reply_markup: kb.reply_markup,
        });
      } else {
        await ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
      }
    } catch (e) {
      console.error("OPEN action error:", e);
      try { await ctx.answerCbQuery("Ошибка"); } catch {}
    }
  });

  // ===== выложить в глобал =====
  bot.action(/PUB:([^:]+):(\d+)/, async (ctx) => {
    try {
      const id = ctx.match[1];
      const page = Number(ctx.match[2] || 0);
      const owner = `tg:${ctx.from.id}`;

      const { rows } = await pool.query(
        `select data from local_recipes where owner=$1 and id=$2`,
        [owner, id]
      );
      if (!rows.length) return ctx.answerCbQuery("Не найдено");

      await pool.query(
        `insert into recipes (id, data) values ($1,$2)
         on conflict (id) do update set data=excluded.data`,
        [id, normalizeForGlobal(rows[0].data)]
      );

      // сброс кэша, если у тебя он есть выше; иначе просто убери эту строку
      if (typeof invalidateRecipesCache === "function") {
        invalidateRecipesCache();
      }

      await ctx.answerCbQuery("Опубликовано ✅");
      await ctx.editMessageReplyMarkup(
        Markup.inlineKeyboard([
          [Markup.button.callback("🗑 Удалить из глобала", `UNPUB:${id}:${page}`)],
          [Markup.button.callback("← К списку", `LIST:${page}`)],
        ]).reply_markup
      );
    } catch (e) {
      console.error("PUB action error:", e);
      try { await ctx.answerCbQuery("Ошибка публикации"); } catch {}
    }
  });

  // ===== удалить из глобала =====
  bot.action(/UNPUB:([^:]+):(\d+)/, async (ctx) => {
    try {
      const id = ctx.match[1];
      const page = Number(ctx.match[2] || 0);
      const owner = `tg:${ctx.from.id}`;

      // убедимся, что рецепт принадлежит этому пользователю
      const { rows } = await pool.query(
        `select 1 from local_recipes where owner=$1 and id=$2`,
        [owner, id]
      );
      if (!rows.length) return ctx.answerCbQuery("Не найдено");

      await pool.query(`delete from recipes where id=$1`, [id]);

      if (typeof invalidateRecipesCache === "function") {
        invalidateRecipesCache();
      }

      await ctx.answerCbQuery("Удалено из глобала ✅");
      await ctx.editMessageReplyMarkup(
        Markup.inlineKeyboard([
          [Markup.button.callback("📤 Выложить в глобал", `PUB:${id}:${page}`)],
          [Markup.button.callback("← К списку", `LIST:${page}`)],
        ]).reply_markup
      );
    } catch (e) {
      console.error("UNPUB action error:", e);
      try { await ctx.answerCbQuery("Ошибка удаления"); } catch {}
    }
  });

  // ===== ВАЖНО: снести webhook и запустить polling =====
  try {
    const info = await bot.telegram.getWebhookInfo();
    if (info?.url) {
      console.log("Webhook was set to:", info.url, "— deleting…");
    }
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {
    console.warn("deleteWebhook failed (можно игнорировать):", e?.message || e);
  }

  await bot.launch({
    polling: { allowedUpdates: ["message", "callback_query"] },
  });
  console.log("Telegram bot started (polling).");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}


// ---------- START ----------
app.listen(PORT, () => {
  console.log(`API on :${PORT}`);
});

startBot().catch((e) => console.error("startBot failed:", e));


app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  try {
    if (!res.headersSent) {
      const origin = req.headers.origin;
      if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      res.setHeader("Access-Control-Expose-Headers", "ETag, Last-Modified");
    }
  } catch {}
  if (!res.headersSent) {
    res.status(500).json({ error: "internal" });
  } else {
    res.end();
  }
});

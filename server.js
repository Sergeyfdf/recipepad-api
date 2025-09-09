import express from "express";
import cors from "cors";
import compression from "compression";
import { Pool } from "pg";
import dns from "dns";

// чтобы на Render/Neon не было проблем с IPv6
dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- БАЗА ДАННЫХ ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // postgres://user:pass@host/db?sslmode=require
  ssl: { rejectUnauthorized: false }          // для Neon/Render
});

// создаём нужные таблицы/триггеры при старте
async function ensureSchema() {
  await pool.query(`
    -- глобальные рецепты (публикуемые)
    create table if not exists recipes (
      id text primary key,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    -- локальные рецепты по владельцу (owner)
    create table if not exists local_recipes (
      owner text not null,
      id text not null,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (owner, id)
    );

    -- общий триггер обновления updated_at
    create or replace function set_updated_at() returns trigger as $$
    begin
      new.updated_at = now();
      return new;
    end $$ language plpgsql;

    drop trigger if exists tr_recipes_updated on recipes;
    create trigger tr_recipes_updated before update on recipes
      for each row execute procedure set_updated_at();

    drop trigger if exists tr_local_recipes_updated on local_recipes;
    create trigger tr_local_recipes_updated before update on local_recipes
      for each row execute procedure set_updated_at();
  `);
}
ensureSchema().catch(err => {
  console.error("ensureSchema error:", err);
});

// ---------- HELPERS ----------
function getOwner(req) {
  // заголовок X-Owner-Id предпочтительнее; fallback — query ?owner=
  return String(req.header("X-Owner-Id") || req.query.owner || "").trim();
}

// простейший кэш списка глобальных рецептов

// ---------- MIDDLEWARE ----------
app.use(cors({
  origin: true, // можно перечислить домены через массив/регэксп, если нужно
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma", "X-Owner-Id"]
}));
app.use(express.json({ limit: "10mb" })); // для data:URL обложек
app.use(compression());

// ---------- HEALTH ----------
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
// =============== ГЛОБАЛЬНЫЕ РЕЦЕПТЫ (публикуемые) ====================
// =====================================================================

// список
app.get("/recipes", async (req, res) => {
  try {

    const { rows } = await pool.query(
      "select id, data, updated_at from recipes order by updated_at desc"
    );
    const payload = rows.map(r => ({ ...r.data, id: r.id }));
    res.set("Cache-Control", "no-store");
    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// получить один
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
  // принудительно подставим id из пути
  const data = { ...recipe, id: req.params.id };

  await pool.query(
    `insert into recipes (id, data) values ($1, $2)
     on conflict (id) do update set data=excluded.data, updated_at=now()`,
    [req.params.id, data]
  );

  // инвалидируем кэш
  RECIPES_CACHE = { body: "", etag: "", lastmod: "", ts: 0 };
  res.json({ ok: true });
});

// удалить
app.delete("/recipes/:id", async (req, res) => {
  await pool.query("delete from recipes where id=$1", [req.params.id]);
  // инвалидируем кэш
  RECIPES_CACHE = { body: "", etag: "", lastmod: "", ts: 0 };
  res.status(204).end();
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
  res.json(rows.map(r => ({ ...r.data, id: r.id })));
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
     on conflict (owner, id) do update set data=excluded.data, updated_at=now()`,
    [owner, req.params.id, data]
  );

  res.json({ ok: true });
});

// удалить локальный рецепт
app.delete("/local/recipes/:id", async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(400).json({ error: "owner required" });

  await pool.query(
    "delete from local_recipes where owner=$1 and id=$2",
    [owner, req.params.id]
  );
  res.status(204).end();
});

// массовая загрузка локальных рецептов
app.post("/local/recipes/bulk", async (req, res) => {
  const owner = getOwner(req);
  if (!owner) return res.status(400).json({ error: "owner required" });
  const arr = Array.isArray(req.body?.recipes) ? req.body.recipes : [];

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const r of arr) {
      const data = { ...r, id: r.id };
      await client.query(
        `insert into local_recipes (owner, id, data) values ($1,$2,$3)
         on conflict (owner, id) do update set data=excluded.data, updated_at=now()`,
        [owner, r.id, data]
      );
    }
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

// =====================================================================
// ========================== ЗАКАЗЫ (Telegram) =========================
// =====================================================================

app.post("/orders", async (req, res) => {
  try {
    const BOT  = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    const CHAT = process.env.TELEGRAM_CHAT_ID   || process.env.TG_CHAT_ID;
    if (!BOT || !CHAT) {
      return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set" });
    }

    const { title } = req.body ?? {};
    if (!title || typeof title !== "string" || title.trim().length < 2) {
      return res.status(400).json({ error: "title is required" });
    }

    function nowKyiv() {
      return new Intl.DateTimeFormat('uk-UA', {
        timeZone: 'Europe/Kyiv',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date());
    }

    const text =
      `📦 НОВЫЙ ЗАКАЗ ИЗ RECIPEPAD!\n\n` +
      `🍳 Блюдо: ${title}\n` +
      `⏰ Время: ${nowKyiv()}\n` +
      `📱 Отправлено с сайта`;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 8000);

    let resp, data;
    try {
      resp = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT, text }),
        signal: controller.signal,
      });
      data = await resp.json().catch(async () => ({ raw: await resp.text() }));
    } finally {
      clearTimeout(to);
    }

    if (!resp.ok || data?.ok === false) {
      console.error("Telegram failed", { http: resp?.status, data });
      return res.status(502).json({ error: "telegram_failed", details: data });
    }

    return res.json({ ok: true });
  } catch (e) {
    const cause = e && typeof e === "object" && "cause" in e ? e.cause : null;
    console.error("orders handler error", {
      message: String(e),
      name: e?.name,
      code: cause?.code,
      errno: cause?.errno,
      address: cause?.address,
      port: cause?.port,
    });
    return res.status(500).json({ error: "internal", details: String(e) });
  }
});

// быстрая проверка токена бота
app.get("/debug/tg", async (_req, res) => {
  const BOT  = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;
  if (!BOT) return res.status(500).json({ error: "no BOT token" });
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT}/getMe`);
    const j = await r.json();
    res.json({ http: r.status, body: j });
  } catch (e) {
    res.status(500).json({ error: "fetch_failed", details: String(e) });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`API on :${PORT}`);
});

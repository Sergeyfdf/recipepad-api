import express from "express";
import cors from "cors";
import compression from "compression";
import { Pool } from "pg";
import dns from "dns";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

// чтобы на Render/Neon не было проблем с IPv6
dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- БАЗА ДАННЫХ ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // postgres://user:pass@host/db?sslmode=require
  ssl: { rejectUnauthorized: false }          // для Neon/Render
});


const CACHE_TTL_MS = 15_000;

const RECIPES_CACHE = {
  body: "",
  etag: "",
  lastmod: "",
  ts: 0, // unix ms
};

function invalidateRecipesCache() {
  RECIPES_CACHE.body = "";
  RECIPES_CACHE.etag = "";
  RECIPES_CACHE.lastmod = "";
  RECIPES_CACHE.ts = 0;
}

// создаём нужные таблицы/триггеры при старте
async function ensureSchema() {
  await pool.query(`
    -- ============================
    -- Tables
    -- ============================

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

    -- ============================
    -- Common trigger: touch updated_at
    -- (используем отдельное имя, чтобы не конфликтовать с тем,
    -- что уже могло существовать раньше)
    -- ============================

    create or replace function touch_updated_at() returns trigger as $$
    begin
      new.updated_at = now();
      return new;
    end $$ language plpgsql;

    -- триггер для recipes
    drop trigger if exists tr_touch_updated_at_recipes on recipes;
    create trigger tr_touch_updated_at_recipes
      before update on recipes
      for each row execute procedure touch_updated_at();

    -- триггер для local_recipes
    drop trigger if exists tr_touch_updated_at_local_recipes on local_recipes;
    create trigger tr_touch_updated_at_local_recipes
      before update on local_recipes
      for each row execute procedure touch_updated_at();

    -- ============================
    -- Полезные индексы (опционально)
    -- ============================

    create index if not exists idx_recipes_updated_at on recipes (updated_at desc);
    create index if not exists idx_local_recipes_updated_at on local_recipes (updated_at desc);
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






function verifyTelegramAuth(data) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;
  if (!token) throw new Error("No TELEGRAM_BOT_TOKEN");

  const { hash, ...rest } = data;
  const checkString = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('\n');

  const secret = crypto.createHash('sha256').update(token).digest();
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  return hmac === hash;
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
    // быстрый ответ из кэша
    if (RECIPES_CACHE.body && Date.now() - RECIPES_CACHE.ts < CACHE_TTL_MS) {
      if (req.headers["if-none-match"] === RECIPES_CACHE.etag) {
        return res.status(304).end();
      }
      res.set("ETag", RECIPES_CACHE.etag);
      res.set("Last-Modified", RECIPES_CACHE.lastmod);
      res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
      return res.type("application/json").send(RECIPES_CACHE.body);
    }

    const { rows } = await pool.query(
      "select id, data, updated_at from recipes order by updated_at desc"
    );
    const payload = rows.map(r => ({ ...r.data, id: r.id }));
    const body = JSON.stringify(payload);

    const count = rows.length;
    const maxUpdated = rows[0]?.updated_at ? new Date(rows[0].updated_at) : new Date();
    const etag = `"r${count}-${+maxUpdated}"`;
    const lastmod = maxUpdated.toUTCString();

    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    // записываем в кэш (НЕ пересоздаём объект)
    RECIPES_CACHE.body = body;
    RECIPES_CACHE.etag = etag;
    RECIPES_CACHE.lastmod = lastmod;
    RECIPES_CACHE.ts = Date.now();

    res.set("ETag", etag);
    res.set("Last-Modified", lastmod);
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
    res.type("application/json").send(body);
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
  await pool.query(
    `insert into recipes (id, data) values ($1, $2)
     on conflict (id) do update set data=excluded.data`,
    [req.params.id, recipe]
  );
  invalidateRecipesCache();
  res.json({ ok: true });
});

// удалить
app.delete("/recipes/:id", async (req, res) => {
  await pool.query("delete from recipes where id=$1", [req.params.id]);
  invalidateRecipesCache();
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
  if (!arr.length) return res.json({ ok: true, count: 0 });

  const client = await pool.connect();
  try {
    await client.query("begin");
    // чуть быстрее импорт: риски минимальные для одноразовой миграции
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






app.get("/recipes/:id/exists", async (req, res) => {
  const { rows } = await pool.query("select 1 from recipes where id=$1 limit 1", [req.params.id]);
  res.json({ exists: rows.length > 0 });
});

// и лучше без кэша на списке/элементе
app.get("/recipes", async (req, res) => {
  const { rows } = await pool.query(
    "select id, data, updated_at from recipes order by updated_at desc"
  );
  const payload = rows.map(r => ({ ...r.data, id: r.id }));
  res.set("Cache-Control", "no-store");
  res.json(payload);
});

app.get("/recipes/:id", async (req, res) => {
  const { rows } = await pool.query("select id, data from recipes where id=$1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "not found" });
  res.set("Cache-Control", "no-store");
  res.json({ ...rows[0].data, id: rows[0].id });
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

    const text =
      `📦 НОВЫЙ ЗАКАЗ ИЗ RECIPEPAD!\n\n` +
      `🍳 Блюдо: ${title}\n` +
      `⏰ Время: ${new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" })}\n` +
      `📱 Отправлено с сайта`;

    async function sendWithTimeout(timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: CHAT, text }),
          signal: controller.signal,
        });
        const data = await resp.json().catch(async () => ({ raw: await resp.text() }));
        return { resp, data };
      } finally {
        clearTimeout(timer);
      }
    }

    // 2 ретрая с нарастающим таймаутом
    let lastErr = null;
    for (const t of [8000, 12000, 15000]) {
      try {
        const { resp, data } = await sendWithTimeout(t);
        if (resp.ok && data?.ok !== false) {
          return res.json({ ok: true });
        }
        lastErr = { http: resp.status, data };
      } catch (e) {
        lastErr = e;
      }
    }

    console.warn("telegram_failed", lastErr);
    return res.status(502).json({ error: "telegram_failed" });
  } catch (e) {
    console.error("orders handler error", String(e));
    return res.status(500).json({ error: "internal" });
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








app.post("/auth/telegram", async (req, res) => {
  try {
    const data = req.body; // объект, который приходит из виджета
    if (!verifyTelegramAuth(data)) return res.status(403).json({ error: "bad_signature" });

    const tg_id = String(data.id);
    await pool.query(`
      insert into users (tg_id, username, first_name, last_name, photo_url)
      values ($1,$2,$3,$4,$5)
      on conflict (tg_id) do update set
        username = excluded.username,
        first_name = excluded.first_name,
        last_login = now(),
        photo_url = excluded.photo_url
    `, [tg_id, data.username || null, data.first_name || null, data.last_name || null, data.photo_url || null]);

    const jwtSecret = process.env.JWT_SECRET || "dev-secret";
    const token = jwt.sign({ sub: `tg:${tg_id}`, tg_id }, jwtSecret, { expiresIn: "90d" });

    res.json({
      ok: true,
      jwt: token,
      ownerId: `tg:${tg_id}`,      // ← это и будем класть в X-Owner-Id
      profile: {
        username: data.username,
        first_name: data.first_name,
        photo_url: data.photo_url
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});


import { Telegraf, Markup } from "telegraf";

async function startBot() {
  const BOT = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;
  if (!BOT) return;

  const bot = new Telegraf(BOT);

  // Пагинация: 5 рецептов на страницу
  const PAGE_SIZE = 5;

  bot.start(async (ctx) => {
    await ctx.reply(
      "Привет! Выбирай, что сделать:",
      Markup.inlineKeyboard([
        [Markup.button.callback("Мои рецепты", "LIST:0")],
      ])
    );
  });

  // Показать список
  bot.action(/LIST:(\d+)/, async (ctx) => {
    const page = Number(ctx.match[1] || 0);
    const owner = `tg:${ctx.from.id}`;

    const { rows } = await pool.query(
      `select id, data from local_recipes where owner=$1 order by updated_at desc`,
      [owner]
    );
    if (!rows.length) {
      return ctx.editMessageText("Пока нет рецептов. Добавь их в веб-приложении 👩‍🍳");
    }

    const from = page * PAGE_SIZE;
    const slice = rows.slice(from, from + PAGE_SIZE);

    const buttons = slice.map(r =>
      [Markup.button.callback(r.data.title || r.id, `OPEN:${r.id}:${page}`)]
    );

    const nav = [];
    if (page > 0) nav.push(Markup.button.callback("« Назад", `LIST:${page - 1}`));
    if (from + PAGE_SIZE < rows.length) nav.push(Markup.button.callback("Вперёд »", `LIST:${page + 1}`));
    if (nav.length) buttons.push(nav);

    await ctx.editMessageText(`Мои рецепты (стр. ${page + 1})`, Markup.inlineKeyboard(buttons));
  });

  // Открыть рецепт (карточка)
  bot.action(/OPEN:([^:]+):(\d+)/, async (ctx) => {
    const id = ctx.match[1];
    const page = Number(ctx.match[2] || 0);
    const owner = `tg:${ctx.from.id}`;

    const { rows } = await pool.query(
      `select data from local_recipes where owner=$1 and id=$2`,
      [owner, id]
    );
    if (!rows.length) {
      return ctx.answerCbQuery("Не найдено");
    }

    const r = rows[0].data || {};
    const title = r.title || "Без названия";
    const ingredients = (Array.isArray(r.parts) && r.parts.length
      ? r.parts.flatMap(p => p.ingredients)
      : r.ingredients) || [];
    const steps = (Array.isArray(r.parts) && r.parts.length
      ? r.parts.flatMap(p => p.steps)
      : r.steps) || [];

    const text =
      `*${escapeMd(title)}*\n` +
      (r.description ? `${escapeMd(r.description)}\n\n` : "") +
      (ingredients.length ? `*Ингредиенты:*\n• ${escapeMd(ingredients.join("\n• "))}\n\n` : "") +
      (steps.length ? `*Шаги:*\n${escapeMd(steps.map((s,i)=>`${i+1}. ${s}`).join("\n"))}\n` : "");

    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("📤 Выложить в глобал", `PUB:${id}:${page}`)],
      [Markup.button.callback("← К списку", `LIST:${page}`)]
    ]);

    // если обложка — http(s), пришлём фото; иначе — только текст
    if (r.cover && /^https?:\/\//i.test(r.cover)) {
      await ctx.replyWithPhoto(r.cover, { caption: text, parse_mode: "Markdown" , reply_markup: kb.reply_markup });
    } else {
      await ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
    }
  });

  // Публикация в глобал
  bot.action(/PUB:([^:]+):(\d+)/, async (ctx) => {
    const id = ctx.match[1];
    const page = Number(ctx.match[2] || 0);
    const owner = `tg:${ctx.from.id}`;

    const { rows } = await pool.query(
      `select id, data from local_recipes where owner=$1 and id=$2`,
      [owner, id]
    );
    if (!rows.length) return ctx.answerCbQuery("Не найдено");

    // upsert в recipes (глобал)
    await pool.query(
      `insert into recipes (id, data) values ($1,$2)
       on conflict (id) do update set data=excluded.data`,
      [id, normalizeForGlobal(rows[0].data)]
    );

    // обнулим кэш списка глобала (если используешь кэш)
    RECIPES_CACHE = { body: "", etag: "", lastmod: "", ts: 0 };

    await ctx.answerCbQuery("Опубликовано ✅");
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
      [Markup.button.callback("← К списку", `LIST:${page}`)]
    ]).reply_markup);
  });

  function escapeMd(s="") {
    return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }
  function normalizeForGlobal(rec) {
    // приведение к твоей file-схеме: перенос частей/ингредиентов как в фронте
    const base = {
      id: rec.id, title: rec.title, description: rec.description || "",
      cover: rec.cover, createdAt: rec.createdAt || Date.now(),
      favorite: !!rec.favorite, categories: rec.categories || [], done: !!rec.done,
      parts: Array.isArray(rec.parts) ? rec.parts : [],
      ingredients: [], steps: []
    };
    if (!Array.isArray(rec.parts) || rec.parts.length === 0) {
      base.ingredients = Array.isArray(rec.ingredients) ? rec.ingredients : [];
      base.steps = Array.isArray(rec.steps) ? rec.steps : [];
    }
    return base;
  }

  await bot.launch();
  console.log("Telegram bot started");
}
startBot().catch(console.error);



// ---------- START ----------
app.listen(PORT, () => {
  console.log(`API on :${PORT}`);
});

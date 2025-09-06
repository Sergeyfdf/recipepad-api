import express from "express";
import cors from "cors";
import { Pool } from "pg";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({
  origin: true, // разрешаем всех (или укажи конкретные домены)
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"],
}));
app.use(express.json({ limit: "10mb" })); // чтобы json с картинкой тоже пролезал

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // для Neon/Render
});

// создаём таблицу при старте (id + jsonb)
async function ensureSchema() {
  await pool.query(`
    create table if not exists recipes (
      id text primary key,
      data jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create or replace function set_updated_at() returns trigger as $$
    begin
      new.updated_at = now(); 
      return new;
    end $$ language plpgsql;
    drop trigger if exists tr_set_updated_at on recipes;
    create trigger tr_set_updated_at before update on recipes
    for each row execute procedure set_updated_at();
  `);
}
ensureSchema().catch(console.error);

// health
app.get("/health", (_req, res) => res.json({ ok: true }));

// список рецептов (просто массив Recipe — как у тебя во фронте)
app.get("/recipes", async (_req, res) => {
  const { rows } = await pool.query("select id, data from recipes order by updated_at desc");
  // отдаём только data (как ты и ожидаешь)
  res.json(rows.map(r => ({ ...r.data, id: r.id })));
});

// получить 1 рецепт
app.get("/recipes/:id", async (req, res) => {
  const { rows } = await pool.query("select id, data from recipes where id=$1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "not found" });
  res.json({ ...rows[0].data, id: rows[0].id });
});

// выложить/обновить рецепт (upsert)
app.put("/recipes/:id", async (req, res) => {
  const recipe = req.body?.recipe;
  if (!recipe || typeof recipe !== "object") {
    return res.status(400).json({ error: "body.recipe required" });
  }
  // можно облегчать рецепт (например, убрать base64-картинку):
  // const { cover, ...rest } = recipe;
  // const data = { ...rest, coverUrl: (cover?.startsWith("http") ? cover : undefined) };
  const data = recipe;

  await pool.query(
    `insert into recipes (id, data) values ($1, $2)
     on conflict (id) do update set data=excluded.data`,
    [req.params.id, data]
  );
  res.json({ ok: true });
});

// удалить из глобала
app.delete("/recipes/:id", async (req, res) => {
  await pool.query("delete from recipes where id=$1", [req.params.id]);
  res.status(204).end();
});


app.post("/orders", async (req, res) => {
  try {
    const token = process.env.TG_BOT_TOKEN;
    const chatId = process.env.TG_CHAT_ID;
    if (!token || !chatId) {
      return res.status(500).json({ error: "Telegram creds are not set" });
    }

    const { title, image } = req.body || {};
    if (!title || typeof title !== "string" || title.trim().length < 2) {
      return res.status(400).json({ error: "title is required" });
    }

    // Доп. инфа: IP/UA (удобно в уведомлении)
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString();
    const ua = (req.headers["user-agent"] || "").toString();

    const text =
  `📦 НОВЫЙ ЗАКАЗ ИЗ RECIPEPAD!\n\n` +
  `🍳 Блюдо: ${title}\n` +
  `⏰ Время: ${new Date().toLocaleString('ru-RU')}\n` +
  `📱 Отправлено с сайта`;

    // Если картинка не нужна — можно всегда sendMessage
    // Если захотите отправлять фото URL — меняйте на sendPhoto
    const tgResp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });

    const ok = tgResp.ok;
    if (!ok) {
      const body = await tgResp.text();
      console.error("Telegram error:", body);
      return res.status(502).json({ error: "telegram failed" });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});


app.listen(PORT, () => {
  console.log("API listening on", PORT);
});

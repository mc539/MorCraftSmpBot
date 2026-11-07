import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import mineflayer from "mineflayer";

const required = ["GEMINI_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const systemInstruction = process.env.BOT_SYSTEM_PROMPT ||
  "Sen MorCraftSmp Minecraft sunucusunun MVP oyuncularına özel yardımcı yapay zekâsısın. Türkçe, samimi, kısa ve faydalı cevap ver. Sunucu kuralları veya özellikleri hakkında emin olmadığın bilgileri uydurma. Asla coin bakiyesi değiştirdiğini, ödeme aldığını veya rütbe verdiğini iddia etme. Şifre, API anahtarı veya kişisel bilgi isteme.";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
const allowedOrigins = (process.env.WEBSITE_ORIGIN || "")
  .split(",").map(x => x.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed"));
  }
}));

const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.WEB_CHAT_PER_MINUTE || 8),
  standardHeaders: "draft-8",
  legacyHeaders: false
});
const sessions = new Map();
const MAX_HISTORY = 12;
const MAX_SESSIONS = 500;

function cleanText(value, max = 1200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseJsonEnv(name) {
  try { return JSON.parse(process.env[name] || "{}"); }
  catch { console.error(`Invalid JSON in ${name}`); return {}; }
}

function safeTokenEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

const webMvpTokens = parseJsonEnv("MVP_ACCESS_TOKENS");
function isWebMvp(username, token) {
  const expected = webMvpTokens[cleanText(username, 32).toLowerCase()];
  return safeTokenEqual(token, expected);
}

async function askGemini(sessionId, message) {
  const history = sessions.get(sessionId) || [];
  const contents = [...history, { role: "user", parts: [{ text: message }] }];
  const response = await ai.models.generateContent({
    model,
    contents,
    config: { systemInstruction, maxOutputTokens: 450, temperature: 0.7 }
  });
  const answer = cleanText(response.text, 3500) || "Şu anda cevap oluşturamadım. Biraz sonra tekrar dener misin?";
  const nextHistory = [
    ...history,
    { role: "user", parts: [{ text: message }] },
    { role: "model", parts: [{ text: answer }] }
  ].slice(-MAX_HISTORY);
  if (sessions.size >= MAX_SESSIONS && !sessions.has(sessionId)) sessions.delete(sessions.keys().next().value);
  sessions.set(sessionId, nextHistory);
  return answer;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "morcraftsmp-ai" }));

const storeProducts = {
  vip: { name: "VIP", price: 30000, group: "vip" },
  mvp: { name: "MVP", price: 60000, group: "mvp" },
  "vip-plus": { name: "VIP+", price: 100000, group: "vip+" }
};
const linkChallenges = new Map();
const storeSessions = new Map();
const storeBusy = new Set();
function validPlayerName(value) { return typeof value === "string" && /^[a-zA-Z0-9_]{1,16}$/.test(value); }
function makeLinkCode() { return crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase(); }
function runMinecraftCommand(command, successRegex, failureRegex) {
  return new Promise(resolve => {
    if (!mcBot || !mcBot.player) return resolve({ ok: false, reason: "Minecraft botu sunucuya bağlı değil." });
    let settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); mcBot.removeListener("messagestr", onMessage); resolve(result); };
    const onMessage = message => { const line = String(message || ""); if (failureRegex.test(line)) return finish({ ok: false, reason: line.slice(0, 180) }); if (successRegex.test(line)) return finish({ ok: true, message: line.slice(0, 180) }); };
    const timer = setTimeout(() => finish({ ok: false, reason: "Sunucu komut sonucu zamanında doğrulanamadı." }), economyTimeoutMs);
    mcBot.on("messagestr", onMessage);
    mcBot.chat(command);
  });
}
const lpSuccess = new RegExp(process.env.LP_SUCCESS_REGEX || "(?:successfully|success|başarıyla|başarılı)", "i");
const lpFailure = new RegExp(process.env.LP_FAILURE_REGEX || "(?:error|unknown group|does not exist|not found|no permission|yetkin yok|izin yok|hata)", "i");

app.post("/api/store/link/start", (req, res) => {
  const username = cleanText(req.body?.username, 16);
  if (!validPlayerName(username)) return res.status(400).json({ error: "Geçerli bir Minecraft kullanıcı adı gir." });
  if (!mcBot?.player || botState !== "online") {
    return res.status(503).json({ error: "Mağaza şu anda kullanılamıyor: MorCraftAi sunucuya bağlı değil. Önce Aternos sunucusunu açıp botun çevrimiçi olmasını bekle." });
  }
  const code = makeLinkCode();
  linkChallenges.set(code, { username: username.toLowerCase(), expires: Date.now() + 5 * 60_000, verified: false });
  return res.json({ code, expiresInSeconds: 300 });
});
app.get("/api/store/link/status", (req, res) => {
  const code = cleanText(req.query?.code, 6).toUpperCase();
  const challenge = linkChallenges.get(code);
  if (!/^[A-Z0-9]{6}$/.test(code) || !challenge || challenge.expires < Date.now()) {
    linkChallenges.delete(code);
    return res.status(404).json({ error: "Kod bulunamadı veya süresi doldu. Yeni kod oluştur." });
  }
  if (!challenge.verified) return res.json({ verified: false });
  if (!challenge.sessionToken) {
    challenge.sessionToken = crypto.randomBytes(32).toString("hex");
    storeSessions.set(challenge.sessionToken, { username: challenge.username, expires: Date.now() + 15 * 60_000 });
  }
  return res.json({ verified: true, sessionToken: challenge.sessionToken, username: challenge.username });
});
app.post("/api/store/purchase", async (req, res) => {
  const token = cleanText(req.body?.sessionToken, 100);
  const productId = cleanText(req.body?.product, 30);
  const session = storeSessions.get(token);
  const product = storeProducts[productId];
  if (!session || session.expires < Date.now()) return res.status(401).json({ error: "Site bağlantın geçersiz. Oyunda yeniden doğrula." });
  if (!product) return res.status(400).json({ error: "Geçersiz ürün." });
  const username = session.username;
  if (storeBusy.has(username)) return res.status(409).json({ error: "Bir satın alma işlemin zaten devam ediyor." });
  if (!mcBot || !mcBot.player) return res.status(503).json({ error: "Minecraft botu şu anda sunucuya bağlı değil." });
  storeBusy.add(username);
  try {
    const debit = await runMinecraftCommand(
      `/eco take ${username} ${product.price}`,
      new RegExp(process.env.MC_ECO_SUCCESS_REGEX || "(?:took|removed|deducted|withdrawn|alındı|çekildi|kaldırıldı|düşüldü|çıkarıldı)", "i"),
      new RegExp(process.env.MC_ECO_FAILURE_REGEX || "(?:not enough|insufficient|cannot take|does not have|no permission|you do not have permission|yeterli değil|yetkin yok|iznin yok|izin yok|bakiye yetersiz)", "i")
    );
    if (!debit.ok) return res.status(400).json({ error: "Coin kesintisi yapılamadı: " + debit.reason });
    const rank = await runMinecraftCommand(`/lp user ${username} parent set ${product.group}`, lpSuccess, lpFailure);
    if (!rank.ok) {
      const refund = await runMinecraftCommand(
        `/eco give ${username} ${product.price}`,
        new RegExp(process.env.MC_ECO_REFUND_REGEX || "(?:gave|added|received|eklendi|verildi|başarıyla)", "i"),
        new RegExp(process.env.MC_ECO_FAILURE_REGEX || "(?:error|no permission|yetkin yok|izin yok|hata)", "i")
      );
      console.error("LuckPerms rank command not confirmed; refund result:", refund.ok, rank.reason);
      return res.status(502).json({ error: refund.ok ? "Rütbe verilemedi; oyun paran iade edildi." : "Rütbe ve iade işlemi doğrulanamadı. Yetkiliyle iletişime geç." });
    }
    return res.json({ ok: true, message: product.name + " rütben başarıyla verildi!", product: product.name, price: product.price });
  } catch (error) {
    console.error("Store purchase failed:", error?.message || "unknown error");
    return res.status(500).json({ error: "Satın alma sırasında beklenmeyen hata oluştu." });
  } finally { storeBusy.delete(username); }
});


// Website AI is MVP-only. Each MVP receives an individual token stored server-side.
app.post("/api/chat", chatLimiter, async (req, res) => {
  const username = cleanText(req.body?.username, 32);
  const accessToken = cleanText(req.body?.accessToken, 200);
  const message = cleanText(req.body?.message);
  const sessionId = cleanText(req.body?.sessionId, 80);
  if (!isWebMvp(username, accessToken)) return res.status(403).json({ error: "Bu yapay zekâ yalnızca doğrulanmış MVP oyuncularına açıktır." });
  if (!message) return res.status(400).json({ error: "Mesaj boş olamaz." });
  if (!sessionId || !/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) return res.status(400).json({ error: "Geçersiz sohbet oturumu." });
  try {
    const answer = await askGemini(`web:${username.toLowerCase()}:${sessionId}`, message);
    return res.json({ answer });
  } catch (error) {
    console.error("Web chat request failed:", error?.message || "unknown error");
    return res.status(503).json({ error: "Yapay zekâ şu anda yanıt veremiyor. Biraz sonra tekrar dene." });
  }
});

// Minecraft bot lifecycle. Reconnect attempts only establish a normal connection;
// they do not move the player or try to keep an Aternos server awake.
let mcBot = null;
let botState = "stopped";
let botLastError = "";
let botRetryTimer = null;
let botNextAttemptAt = 0;
const mcHost = cleanText(process.env.MC_HOST, 255);
const mcUsername = cleanText(process.env.MC_USERNAME, 16);
const mcPort = Number(process.env.MC_PORT || 25565);
const mcVersion = process.env.MC_VERSION || "1.21.4";
const mvpNames = new Set((process.env.MVP_USERNAMES || "")
  .split(",").map(x => x.trim().toLowerCase()).filter(Boolean));
const lastMinecraftRequest = new Map();
const minecraftRequestsInFlight = new Set();
const aiQuestionCost = 1000;
const economyTimeoutMs = Number(process.env.MC_ECONOMY_TIMEOUT_MS || 8000);
const economySuccessPattern = new RegExp(
  process.env.MC_ECO_SUCCESS_REGEX || "(?:took|removed|deducted|withdrawn|alındı|çekildi|kaldırıldı|düşüldü|çıkarıldı)",
  "i"
);
const economyFailurePattern = new RegExp(
  process.env.MC_ECO_FAILURE_REGEX || "(?:not enough|insufficient|cannot take|does not have|no permission|you do not have permission|yeterli değil|yetkin yok|iznin yok|izin yok|bakiye yetersiz)",
  "i"
);

function debitMinecraftPlayer(username, amount) {
  return new Promise(resolve => {
    if (!mcBot || !mcBot.player) return resolve({ ok: false, reason: "Bot sunucuya bağlı değil." });
    const activeBot = mcBot;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeBot.removeListener("messagestr", onMessage);
      resolve(result);
    };
    const onMessage = message => {
      const line = String(message || "");
      if (!line.toLowerCase().includes(username.toLowerCase())) return;
      if (economyFailurePattern.test(line)) return finish({ ok: false, reason: "Bakiye yetersiz veya ekonomi komutu için bot yetkili değil." });
      if (economySuccessPattern.test(line)) return finish({ ok: true });
    };
    const timer = setTimeout(() => finish({
      ok: false,
      reason: "Ekonomi kesintisi sunucu mesajından doğrulanamadı."
    }), economyTimeoutMs);
    activeBot.on("messagestr", onMessage);
    activeBot.chat(`/eco take ${username} ${amount}`);
  });
}

function startMinecraftBot() {
  if (!mcHost || !mcUsername) {
    botState = "disabled";
    botLastError = "Minecraft sunucu bilgileri yapılandırılmamış.";
    return false;
  }
  if (mcBot && (botState === "connecting" || botState === "online")) return true;

  botState = "connecting";
  botLastError = "";
  console.log(`Connecting offline Minecraft bot ${mcUsername} -> ${mcHost}:${mcPort} (${mcVersion})`);
  let bot;
  try {
    bot = mineflayer.createBot({
      host: mcHost, port: mcPort, username: mcUsername,
      auth: "offline", version: mcVersion, hideErrors: false
    });
  } catch (error) {
    botState = "offline";
    botLastError = cleanText(error?.message || "Bot başlatılamadı.", 240);
    return false;
  }
  mcBot = bot;

  bot.once("login", () => {
    if (mcBot !== bot) return;
    botState = "online";
    botLastError = "";
    console.log("Minecraft bot logged in.");
  });
  bot.once("spawn", () => {
    if (mcBot === bot) console.log("Minecraft bot spawned in the world.");
  });

  bot.on("chat", async (username, message) => {
    if (!username || username.toLowerCase() === mcUsername.toLowerCase() || mcBot !== bot) return;
    const linkMatch = message.match(/^!site\s+([A-Z0-9]{6})$/i);
    if (linkMatch) {
      const code = linkMatch[1].toUpperCase();
      const challenge = linkChallenges.get(code);
      if (challenge && challenge.expires >= Date.now() && challenge.username === username.toLowerCase()) {
        challenge.verified = true;
        bot.chat(`@${username} Site bağlantın doğrulandı. Web sitesine dönüp bekle.`);
      } else {
        bot.chat(`@${username} Bağlantı kodu geçersiz, süresi dolmuş veya kullanıcı adı eşleşmiyor.`);
      }
      return;
    }
    const match = message.match(/^!ai\s+([\s\S]+)/i);
    if (!match || !/^[a-zA-Z0-9_]{1,16}$/.test(username)) return;
    const playerKey = username.toLowerCase();
    if (minecraftRequestsInFlight.has(playerKey)) {
      bot.chat(`@${username} Sorun zaten işleniyor, lütfen bekle.`);
      return;
    }
    const now = Date.now();
    const last = lastMinecraftRequest.get(playerKey) || 0;
    if (now - last < 15_000) {
      bot.chat(`@${username} Yeni soru için 15 saniye beklemelisin.`);
      return;
    }
    const question = cleanText(match[1], 700);
    if (!question) return;
    minecraftRequestsInFlight.add(playerKey);
    try {
      const answer = await askGemini(`minecraft:${playerKey}`, question);
      const debit = await debitMinecraftPlayer(username, aiQuestionCost);
      if (!debit.ok) {
        sessions.delete(`minecraft:${playerKey}`);
        if (mcBot === bot && bot.player) bot.chat(`@${username} 1.000 oyun parası alınamadı. ${debit.reason}`);
        return;
      }
      lastMinecraftRequest.set(playerKey, Date.now());
      if (mcBot === bot && bot.player) bot.chat(`@${username} 1.000 oyun parası kesildi. ${answer.replace(/[\r\n]+/g, " ").slice(0, 180)}`);
    } catch (error) {
      console.error("Minecraft AI request failed:", error?.message || "unknown error");
      if (mcBot === bot && bot.player) bot.chat(`@${username} Şu anda cevap veremiyorum; ücret alınmadı.`);
    } finally {
      minecraftRequestsInFlight.delete(playerKey);
    }
  });

  bot.on("kicked", reason => {
    botLastError = cleanText(typeof reason === "string" ? reason : JSON.stringify(reason), 240);
    botState = "offline";
    console.warn("Minecraft bot kicked:", botLastError);
  });
  bot.on("error", error => {
    botLastError = cleanText(error?.message || "Minecraft bağlantı hatası", 240);
    console.error("Minecraft bot error:", botLastError);
  });
  bot.on("end", reason => {
    console.warn("Minecraft bot disconnected:", reason || "connection ended");
    if (mcBot === bot) {
      mcBot = null;
      botState = "offline";
    }
  });
  return true;
}

const botStartLimiter = rateLimit({
  windowMs: 60_000,
  limit: 2,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Çok sık başlatma isteği gönderildi. Bir dakika sonra tekrar dene." }
});
app.get("/api/bot/status", (_req, res) => {
  res.json({
    state: botState,
    connected: botState === "online" && Boolean(mcBot?.player),
    lastError: botLastError || null
  });
});
app.post("/api/bot/start", botStartLimiter, (_req, res) => {
  if (!mcHost || !mcUsername) return res.status(503).json({ error: "Bot ayarları henüz tamamlanmamış." });
  if (mcBot?.player) return res.json({ ok: true, state: "online", message: "Bot zaten sunucuda." });
  if (botState === "connecting") return res.json({ ok: true, state: "connecting", message: "Bot zaten bağlanmayı deniyor." });
  const ok = startMinecraftBot();
  return ok
    ? res.status(202).json({ ok: true, state: "connecting", message: "Bot sunucuya bağlanmayı deniyor." })
    : res.status(503).json({ error: botLastError || "Bot başlatılamadı." });
});

// Retry normal connection every 30 seconds while the service is running.
// This lets the bot join after the owner manually starts the Aternos server.
if (process.env.MC_BOT_ENABLED === "true") {
  startMinecraftBot();
  botRetryTimer = setInterval(() => {
    if (!mcBot && botState !== "connecting") startMinecraftBot();
  }, 60_000);
}

let discord;
const discordMvpIds = new Set((process.env.DISCORD_MVP_USER_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
if (process.env.DISCORD_BOT_TOKEN) {
  discord = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
  });
  discord.once("ready", () => console.log(`Discord bot ready: ${discord.user.tag}`));
  discord.on("messageCreate", async message => {
    if (message.author.bot || !discordMvpIds.has(message.author.id)) return;
    if (process.env.DISCORD_CHANNEL_ID && message.channelId !== process.env.DISCORD_CHANNEL_ID) return;
    const raw = message.content || "";
    const mention = discord.user ? raw.includes(`<@${discord.user.id}>`) || raw.includes(`<@!${discord.user.id}>`) : false;
    const commandMatch = raw.match(/^!ai\s+([\s\S]+)/i);
    if (!mention && !commandMatch) return;
    const question = cleanText(commandMatch ? commandMatch[1] : raw.replace(/<@!?\d+>/g, "").trim(), 1000);
    if (!question) return;
    await message.channel.sendTyping().catch(() => {});
    try {
      const answer = await askGemini(`discord:${message.channelId}:${message.author.id}`, question);
      await message.reply({ content: answer.slice(0, 1900), allowedMentions: { repliedUser: false } });
    } catch (error) {
      console.error("Discord chat request failed:", error?.message || "unknown error");
      await message.reply({ content: "Şu anda yapay zekâya ulaşamıyorum. Biraz sonra tekrar dene.", allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  });
  discord.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
    console.error("Discord login failed:", error?.message || "unknown error");
    process.exitCode = 1;
  });
} else {
  console.log("DISCORD_BOT_TOKEN not set; Discord integration disabled.");
}

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => console.log(`MorCraftSmp AI API listening on ${port}`));

async function shutdown() {
  if (mcBot) mcBot.quit("Service shutting down");
  if (discord) await discord.destroy().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

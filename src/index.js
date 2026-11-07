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

// Minecraft bot: joins only when explicitly configured. No anti-AFK movement and no
// automatic reconnect are implemented; it must never be used to keep an Aternos server online.
let mcBot;
const mcHost = cleanText(process.env.MC_HOST, 255);
const mcUsername = cleanText(process.env.MC_USERNAME, 16);
const mcPort = Number(process.env.MC_PORT || 25565);
const mcVersion = process.env.MC_VERSION || "1.21.4";
const mvpNames = new Set((process.env.MVP_USERNAMES || "")
  .split(",").map(x => x.trim().toLowerCase()).filter(Boolean));
const lastMinecraftRequest = new Map();

if (process.env.MC_BOT_ENABLED === "true" && mcHost && mcUsername && mvpNames.size > 0) {
  console.log(`Starting offline Minecraft bot ${mcUsername} -> ${mcHost}:${mcPort} (${mcVersion})`);
  mcBot = mineflayer.createBot({
    host: mcHost,
    port: mcPort,
    username: mcUsername,
    auth: "offline",
    version: mcVersion,
    hideErrors: false
  });

  mcBot.once("login", () => console.log("Minecraft bot logged in."));
  mcBot.once("spawn", () => {
    console.log("Minecraft bot spawned in the world.");
    if (process.env.MC_LOGIN_PASSWORD) {
      setTimeout(() => mcBot?.chat(`/login ${process.env.MC_LOGIN_PASSWORD}`), 1500);
    }
  });

  mcBot.on("chat", async (username, message) => {
    if (!username || username.toLowerCase() === mcUsername.toLowerCase()) return;
    const match = message.match(/^!ai\s+([\s\S]+)/i);
    if (!match) return;
    if (!mvpNames.has(username.toLowerCase())) {
      mcBot.chat(`@${username} Yapay zekâ yalnızca MVP oyuncularına açıktır.`);
      return;
    }
    const now = Date.now();
    const last = lastMinecraftRequest.get(username.toLowerCase()) || 0;
    if (now - last < 15_000) {
      mcBot.chat(`@${username} Bir sonraki sorunu göndermeden önce biraz bekle.`);
      return;
    }
    lastMinecraftRequest.set(username.toLowerCase(), now);
    const question = cleanText(match[1], 700);
    if (!question) return;
    try {
      const answer = await askGemini(`minecraft:${username.toLowerCase()}`, question);
      // Keep the reply within Minecraft chat's practical length.
      mcBot.chat(`@${username} ${answer.replace(/[\r\n]+/g, " ").slice(0, 220)}`);
    } catch (error) {
      console.error("Minecraft AI request failed:", error?.message || "unknown error");
      mcBot.chat(`@${username} Şu anda cevap veremiyorum, sonra tekrar dene.`);
    }
  });

  mcBot.on("kicked", reason => console.warn("Minecraft bot kicked:", String(reason).slice(0, 300)));
  mcBot.on("error", error => console.error("Minecraft bot error:", error?.message || "unknown error"));
  mcBot.on("end", reason => console.warn("Minecraft bot disconnected:", reason || "connection ended"));
} else {
  console.log("Minecraft bot disabled. Set MC_BOT_ENABLED=true, MC_HOST, MC_USERNAME and MVP_USERNAMES to enable.");
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

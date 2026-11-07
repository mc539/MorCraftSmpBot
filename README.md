# MorCraftSmp AI Bot

Node.js service for:
- Gemini-powered website chat API
- Discord bot replies in a configured channel (or when mentioned / called with `!ai`)
- Future Minecraft chat bridge through a supported Aternos plugin such as DiscordSRV

## Current status
This is the first safe foundation. It does **not** read Minecraft chat directly, change player balances, sell ranks, or execute server commands. Do not advertise rank purchases as active until the economy integration has been implemented and tested.

## Aternos + Spigot chat bridge
Aternos only allows plugins from its built-in plugin library; uploading an arbitrary custom JAR is not supported. Install a compatible bridge plugin from the Aternos library (DiscordSRV is one possible route if available for the server version), configure it to relay Minecraft chat to a dedicated Discord text channel, then set `DISCORD_CHANNEL_ID` to that channel.

This bot responds when a player uses `!ai <question>` or mentions the bot. Bot-originated messages are ignored to prevent reply loops. Test that the bridge relays bot replies back to Minecraft before opening it to players.

Aternos documentation:
- https://support.aternos.org/hc/en-us/articles/360026950892-Install-plugins-Minecraft-Java-Edition
- https://support.aternos.org/hc/en-us/articles/360027235831-Uploading-files-and-FTP-access
DiscordSRV setup:
- https://docs.discordsrv.com/installation/initial-setup/

## Local setup
1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Add a Gemini API key from https://aistudio.google.com/app/apikey.
4. Add a Discord bot token if Discord chat is needed.
5. Set the website's exact origin in `WEBSITE_ORIGIN`.
6. Run:
   ```bash
   npm install
   npm start
   ```
7. Health check: `GET /health`
8. Website chat: `POST /api/chat` with JSON:
   ```json
   { "sessionId": "a-stable-random-id-123", "message": "Merhaba!" }
   ```

## Render deployment
Create a new Render Web Service from this repository and add the environment variables from `.env.example`. Never commit `.env`, API keys, Discord tokens, admin passwords, or Minecraft credentials.

## Next required information before economy / rank purchases
We must identify the exact installed economy/shop and permission plugins. The site must use the *same* coin provider as the in-game shop. Aternos does not provide arbitrary plugin upload or unrestricted server file/FTP access, so the purchase design must use a supported plugin integration; never expose console credentials or use AI responses to authorize purchases.

Ask the server owner for:
- Minecraft version
- exact economy plugin name (e.g. EssentialsX Economy, PlayerPoints, CoinsEngine, etc.)
- exact rank/permissions plugin (e.g. LuckPerms)
- exact shop plugin currently used

The website transaction must verify the authenticated Minecraft account, read balance server-side, atomically withdraw the price, assign the corresponding rank, and record an idempotent transaction. If any step fails, refund or reconcile before reporting success. Admin rank grants require a separate authenticated admin session and audit log.

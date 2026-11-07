# MorCraftSmp AI Bot

Node.js service for a Gemini-powered AI assistant and an optional Minecraft Java bot.

## Minecraft bot setup (Spigot 1.21.4, cracked/offline mode)

This bot uses Mineflayer and connects as a separate offline-mode Minecraft username. It does not install anything on Aternos.

1. Start the Aternos server manually and wait until it is fully online.
2. Confirm Aternos **Options → Cracked** is enabled. Aternos explains that this disables account authentication and lets anyone join using any username; this creates impersonation risks. See https://support.aternos.org/hc/en-us/articles/360027235691-Allow-cracked-players-to-join-Minecraft-Java-Edition.
3. If the server has a whitelist, add the bot username using Aternos Players settings.
4. Set `MC_BOT_ENABLED=true`, `MC_HOST`, `MC_PORT`, `MC_USERNAME`, and `MC_VERSION=1.21.4` in the hosting provider's secret environment variables. Use the exact address and port shown in the Aternos Connect page; do not assume port 25565.
5. Set `MVP_USERNAMES` to comma-separated MVP player names, excluding the bot name.
6. Deploy/restart the external service while Aternos is already online. The bot connects once; if it disconnects, restart the external service after checking the server. There is deliberately no auto-reconnect, anti-AFK movement, or idle keep-alive.
7. In game, an allowed MVP sends: `!ai merhaba`.

### Important cracked-mode security limitation

In offline/cracked mode, Minecraft does not cryptographically prove that a player owns a username. A different person can join using an MVP's name. Therefore, the in-game MVP username allowlist is only a convenience filter, **not secure identity verification**. A secure MVP-only gate requires an existing authentication/identity system already on the server (for example, a login plugin that players already use) or a separate verified website login. Do not treat username-only checks as secure for private data or admin/economy actions. This bot has no permission to grant ranks or change coins.

If the server has an existing login plugin and the bot must authenticate, set `MC_LOGIN_PASSWORD` as a secret environment variable. Never put it in GitHub.

## Website AI (MVP-only)

The `POST /api/chat` endpoint requires:
- `username`: lowercase Minecraft username
- `accessToken`: individual long random token
- `sessionId`: stable random session ID
- `message`: question

Configure `MVP_ACCESS_TOKENS` as a JSON object mapping lowercase usernames to unique random tokens, e.g. `{"playerone":"a-long-random-secret-token"}`. Tokens are stored only in the host's environment variables. The static website must not contain a shared secret. Give each verified MVP their own token privately.

## Hosting notes

- Node.js 20+
- `npm install`
- `npm start`
- Health check: `GET /health`

A Minecraft connection is a persistent TCP connection. Render's free web instances sleep after inactivity, so they are not suitable for a continuously connected Minecraft bot. Use an always-on worker/host for the bot process, or start the service only when needed. Do not use it to keep an Aternos server online; Aternos explicitly prohibits bots/scripts used to bypass automatic shutdown: https://support.aternos.org/hc/en-us/articles/31771896948253-24-7-Hosting.

## Environment variables

See `.env.example`. Never commit API keys, bot credentials, login passwords, or MVP access tokens.

## Still not implemented

- Automated rank sales / coin deductions
- Admin panel and admin permissions
- Secure in-game MVP identity verification for cracked-mode usernames
- Website frontend chat UI and per-MVP token distribution

Economy integration must wait until the exact economy and permissions plugins are known.
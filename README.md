# MorCraftSmp AI Bot

Node.js service for a Gemini-powered AI assistant and an optional Minecraft Java bot.

## Minecraft bot setup (Spigot 1.21.4, cracked/offline mode)

This bot uses Mineflayer and connects as a separate offline-mode Minecraft username. It does not install anything on Aternos.

1. Start the Aternos server manually and wait until it is fully online.
2. Confirm Aternos **Options → Cracked** is enabled. Aternos explains that this disables account authentication and lets anyone join using any username; this creates impersonation risks. See https://support.aternos.org/hc/en-us/articles/360027235691-Allow-cracked-players-to-join-Minecraft-Java-Edition.
3. If the server has a whitelist, add the bot username using Aternos Players settings.
4. Set `MC_BOT_ENABLED=true`, `MC_HOST=MorCraftSmp.aternos.me`, `MC_PORT=64006`, `MC_USERNAME=MorCraftAi`, and `MC_VERSION=1.21.4` in the hosting provider's secret environment variables. Use the exact address and port shown in the Aternos Connect page; do not assume port 25565.
5. Configure the bot account with permission to run `/eco take <player> 1000` (for EssentialsX this is the `essentials.eco` permission; grant only the minimum needed and do not make the bot OP if avoidable).
6. Deploy/restart the external service while Aternos is already online. The bot connects once; if it disconnects, restart the external service after checking the server. There is deliberately no auto-reconnect, anti-AFK movement, or idle keep-alive.
7. In game, any player can send `!ai merhaba`. Each question costs 1,000 in-game currency. The bot generates the answer, requests the economy deduction, and only posts the answer after a success message is detected.

### Economy message matching

The bot detects success/failure using server chat messages. If your economy plugin uses different wording, configure `MC_ECO_SUCCESS_REGEX` and `MC_ECO_FAILURE_REGEX`. If the deduction result cannot be confirmed, the bot does not post the answer. Test this with a low-stakes player account before public use. In cracked/offline mode, usernames can be impersonated; this setup does not provide secure player identity verification.

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
- Website frontend chat UI and per-MVP token distribution

Economy integration must wait until the exact economy and permissions plugins are known.
# Koroot (كروت)
Digital loyalty cards for cafes: customer joins with a phone number and gets a QR stamp card, cashier stamps it, free reward after N visits, owner sees customers who stopped coming and messages them on WhatsApp.

- `src/worker.js` + `public/`: the app, runs free on Cloudflare Workers (one Durable Object with SQLite per cafe). `npx wrangler deploy`, then `npx wrangler secret put BRIDGE_SECRET`.
- `bridge/`: optional WhatsApp Web bridge (Baileys) for an always-on Node host. Env: KOROOT_URL, BRIDGE_SECRET, MAX_SESSIONS.
- `seed.js` / `server.js`: old local Node version for offline preview only.

Built by Eng Angelo Rezq.

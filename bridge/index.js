// Koroot WhatsApp bridge. Runs on an always-on host (Botkeep free server). One WhatsApp session per cafe.
// Sessions are stored in the Koroot worker (Cloudflare), so a restart or a wiped disk does not log the number out.
import makeWASocket, { Browsers, DisconnectReason, initAuthCreds, BufferJSON, proto, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';

const BASE = (process.env.KOROOT_URL || '').replace(/\/$/, '');
const SECRET = process.env.BRIDGE_SECRET || '';
if (!BASE || !SECRET) { console.error('Set KOROOT_URL and BRIDGE_SECRET'); process.exit(1); }
const MAX_SESSIONS = +(process.env.MAX_SESSIONS || 3); // keep inside the free 512 MB
const log = pino({ level: 'silent' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

async function api(slug, op, { method = 'GET', body } = {}) {
  const url = slug ? `${BASE}/api/bridge/${slug}/${op}` : `${BASE}/api/bridge/${op}`;
  const r = await fetch(url, { method, headers: { 'x-bridge': SECRET, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${op} ${r.status}`);
  return r.json();
}
async function remoteAuth(slug) {
  const get = async k => { const r = await api(slug, 'auth?k=' + encodeURIComponent(k)); return r.v ? JSON.parse(r.v, BufferJSON.reviver) : null; };
  const put = (k, v) => api(slug, 'auth?k=' + encodeURIComponent(k), { method: 'PUT', body: { v: JSON.stringify(v, BufferJSON.replacer) } });
  const del = k => api(slug, 'auth?k=' + encodeURIComponent(k), { method: 'DELETE' });
  const creds = (await get('creds')) || initAuthCreds();
  return {
    state: { creds, keys: {
      get: async (type, ids) => { const out = {}; await Promise.all(ids.map(async id => { let v = await get(`${type}-${id}`); if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v); out[id] = v; })); return out; },
      set: async data => { const t = []; for (const type in data) for (const id in data[type]) { const v = data[type][id]; t.push(v ? put(`${type}-${id}`, v) : del(`${type}-${id}`)); } await Promise.all(t); },
    } },
    saveCreds: () => put('creds', creds),
    wipe: () => del('*'),
  };
}

const sessions = new Map(); // slug -> { sock, status, stop }
const lastReply = new Map();

async function start(slug) {
  if (sessions.has(slug)) return;
  const s = { sock: null, status: 'waiting', stopped: false, retry: 0 };
  sessions.set(slug, s);
  const connect = async () => {
    if (s.stopped) return;
    const auth = await remoteAuth(slug);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
    const sock = makeWASocket({ version, auth: auth.state, logger: log, browser: Browsers.macOS('Chrome'), printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false, generateHighQualityLinkPreview: false });
    s.sock = sock;
    sock.ev.on('creds.update', () => auth.saveCreds().catch(() => {}));
    sock.ev.on('connection.update', async u => {
      const { connection, lastDisconnect, qr } = u;
      try {
        if (qr) { s.status = 'qr'; await api(slug, 'status', { method: 'POST', body: { status: 'qr', qr } }); }
        if (connection === 'open') { s.status = 'open'; s.retry = 0; await api(slug, 'status', { method: 'POST', body: { status: 'open', number: (sock.user?.id || '').split(':')[0].split('@')[0] } }); console.log(slug, 'connected'); }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (s.stopped) return;
          if (code === DisconnectReason.loggedOut) { s.stopped = true; sessions.delete(slug); await auth.wipe(); await api(slug, 'status', { method: 'POST', body: { status: 'logged_out' } }); await api(slug, 'state'); return; }
          s.status = 'closed'; await api(slug, 'status', { method: 'POST', body: { status: 'closed' } });
          await sleep(Math.min(60000, 3000 * ++s.retry)); connect();
        }
      } catch (e) { console.error(slug, 'status', e.message); }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          if (m.key.fromMe || !m.message) continue;
          const jid = m.key.remoteJid || ''; if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue; // only 1:1 chats
          const from = (m.key.senderPn || m.key.remoteJidAlt || jid).split('@')[0].split(':')[0];
          if (!/^\d{8,15}$/.test(from)) continue;
          if (Date.now() - (lastReply.get(slug + from) || 0) < 10 * 60e3) continue; // answer each person at most once per 10 min
          lastReply.set(slug + from, Date.now());
          const r = await api(slug, 'incoming', { method: 'POST', body: { from, origin: BASE } });
          await sleep(rnd(2000, 5000)); await sock.sendPresenceUpdate('composing', jid); await sleep(rnd(1500, 3500));
          await sock.sendMessage(jid, { text: r.reply });
        } catch (e) { console.error(slug, 'incoming', e.message); }
      }
    });
  };
  await connect();
}

// Win-back messages queued by the owner: one at a time, 30 to 75 s apart, the worker caps 40/day per number.
async function outboxLoop() {
  for (;;) {
    for (const [slug, s] of sessions) {
      if (s.status !== 'open') continue;
      try {
        const [item] = await api(slug, 'outbox');
        if (!item) continue;
        const jid = item.phone + '@s.whatsapp.net';
        const ok = await s.sock.onWhatsApp(jid).then(r => r?.[0]?.exists).catch(() => false);
        if (ok) { await s.sock.sendPresenceUpdate('composing', jid); await sleep(rnd(2500, 6000)); await s.sock.sendMessage(jid, { text: item.text }); }
        await api(slug, 'outbox', { method: 'POST', body: { id: item.id, ok: !!ok } });
        await sleep(rnd(30000, 75000));
      } catch (e) { console.error(slug, 'outbox', e.message); }
    }
    await sleep(30000);
  }
}

async function sync() {
  try {
    const slugs = await api('', 'cafes');
    for (const slug of slugs) {
      const st = await api(slug, 'state').catch(() => null); if (!st) continue;
      if (st.enabled && !sessions.has(slug) && sessions.size < MAX_SESSIONS) start(slug).catch(e => { console.error(slug, e.message); sessions.delete(slug); });
      if (!st.enabled && sessions.has(slug)) { const s = sessions.get(slug); s.stopped = true; try { s.sock?.end(undefined); } catch {} sessions.delete(slug); }
    }
  } catch (e) { console.error('sync', e.message); }
}
console.log('Koroot bridge up, max sessions', MAX_SESSIONS);
outboxLoop(); for (;;) { await sync(); await sleep(60000); }

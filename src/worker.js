import QR from 'qrcode';
import { DurableObject } from 'cloudflare:workers';
import html from '../public/app.html';
import manifest from '../public/manifest.json';
import icon from '../public/icon.svg';

const J = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { 'content-type': 'application/json; charset=utf-8' } });
const norm = p => String(p || '').replace(/[^\d]/g, '').replace(/^00/, '');
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex2(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const hex2 = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const DAY = 864e5;

export class Cafe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.sql = ctx.storage.sql; this.env = env;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cafe(k TEXT PRIMARY KEY, v TEXT);
     CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, name TEXT, phone TEXT, stamps INT DEFAULT 0, free INT DEFAULT 0, redeemed INT DEFAULT 0, joined INT);
     CREATE INDEX IF NOT EXISTS cp ON cards(phone);
     CREATE TABLE IF NOT EXISTS wa_auth(k TEXT PRIMARY KEY, v TEXT); CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, text TEXT, status TEXT DEFAULT 'pending', ts INT); CREATE TABLE IF NOT EXISTS visits(card TEXT, ts INT); CREATE INDEX IF NOT EXISTS vc ON visits(card);`);
  }
  get(k) { const r = this.sql.exec('SELECT v FROM cafe WHERE k=?', k).toArray()[0]; return r ? JSON.parse(r.v) : undefined; }
  set(k, v) { this.sql.exec('INSERT OR REPLACE INTO cafe(k,v) VALUES(?,?)', k, JSON.stringify(v)); }
  cfg() { return this.get('cfg'); }
  card(c, cfg) {
    const last = this.sql.exec('SELECT MAX(ts) t, COUNT(*) n FROM visits WHERE card=?', c.id).toArray()[0];
    return { id: c.id, name: c.name, phone: c.phone, stamps: c.stamps, free: c.free, redeemed: c.redeemed, visits: last.n, last: last.t, need: cfg.need, reward: cfg.reward, cafe: { name: cfg.name, slug: cfg.slug, lat: cfg.lat, lng: cfg.lng, wa: cfg.wa || '' } };
  }
  async fetch(req) {
    const u = new URL(req.url); const [, , , slug, act] = u.pathname.split('/'); // /api/cafe/:slug/:act
    const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    if (u.pathname === '/__reg') { const l = this.get('slugs') || []; if (req.method === 'POST') { if (!l.includes(b.slug)) l.push(b.slug); this.set('slugs', l); } return J(l); }
    if (u.pathname.startsWith('/__b/')) return this.bridge(req, u, b);
    if (u.pathname === '/__create') {
      if (this.cfg()) return J({ error: 'exists' }, 409);
      this.set('cfg', { slug: b.slug, name: b.name, pinHash: await sha(b.slug + b.pin), need: +b.need || 6, reward: b.reward || 'قهوة مجانًا', lat: null, lng: null, winbackDays: 14, wa: '', waTemplate: 'وحشتنا يا {name} ☕ بقالك {days} يوم مجيتش. عدّي علينا في {cafe}، {left} زيارة بس وتاخد {reward}.', waToken: '', waPhoneId: '', waVerify: hex(8), waTplName: '' });
      return J({ ok: 1 });
    }
    if (u.pathname.startsWith('/__wa/')) return this.whatsapp(req, u);
    const cfg = this.cfg(); if (!cfg) return J({ error: 'الكافيه غير موجود' }, 404);
    if (!act) return J({ name: cfg.name, slug, need: cfg.need, reward: cfg.reward, wa: cfg.wa });
    if (act === 'join') {
      const ph = norm(b.phone); if (ph.length < 8 || !b.name) return J({ error: 'اكتب الاسم ورقم الموبايل' }, 400);
      let c = this.sql.exec('SELECT * FROM cards WHERE phone=?', ph).toArray()[0];
      if (!c) { const id = slug + '-' + hex(4); this.sql.exec('INSERT INTO cards(id,name,phone,joined) VALUES(?,?,?,?)', id, String(b.name).trim().slice(0, 60), ph, Date.now()); c = { id }; }
      return J({ id: c.id });
    }
    if (act === 'card') { const c = this.sql.exec('SELECT * FROM cards WHERE id=?', b.id || u.searchParams.get('id')).toArray()[0]; return c ? J(this.card(c, cfg)) : J({ error: 'الكارت غير موجود' }, 404); }
    const pin = req.headers.get('x-pin') || b.pin;
    if (await sha(slug + pin) !== cfg.pinHash) return J({ error: 'الرقم السري غير صحيح' }, 401);
    if (act === 'login') return J({ ok: true, name: cfg.name });
    if (act === 'find') {
      const q = String(b.q || '').trim(), ph = norm(q);
      let c = this.sql.exec('SELECT * FROM cards WHERE id=?', q).toArray()[0];
      if (!c && ph.length >= 6) c = this.sql.exec('SELECT * FROM cards WHERE phone=? OR phone LIKE ?', ph, '%' + ph).toArray()[0];
      return c ? J(this.card(c, cfg)) : J({ error: 'مفيش عميل بالكود أو الرقم ده' }, 404);
    }
    if (act === 'stamp' || act === 'redeem') {
      const c = this.sql.exec('SELECT * FROM cards WHERE id=?', b.id).toArray()[0]; if (!c) return J({ error: 'الكارت غير موجود' }, 404);
      if (act === 'stamp') {
        const l = this.sql.exec('SELECT MAX(ts) t FROM visits WHERE card=?', c.id).toArray()[0].t;
        if (l && Date.now() - l < 18e4) return J({ error: 'تم ختم الكارت من أقل من 3 دقائق' }, 429);
        this.sql.exec('INSERT INTO visits VALUES(?,?)', c.id, Date.now());
        let s = c.stamps + 1, f = c.free; if (s >= cfg.need) { s -= cfg.need; f++; }
        this.sql.exec('UPDATE cards SET stamps=?, free=? WHERE id=?', s, f, c.id);
      } else {
        if (c.free < 1) return J({ error: 'مفيش مكافأة جاهزة' }, 400);
        this.sql.exec('UPDATE cards SET free=free-1, redeemed=redeemed+1 WHERE id=?', c.id);
      }
      return J(this.card(this.sql.exec('SELECT * FROM cards WHERE id=?', c.id).toArray()[0], cfg));
    }
    if (act === 'admin') {
      const now = Date.now(), cards = this.sql.exec('SELECT * FROM cards ORDER BY joined DESC LIMIT 2000').toArray();
      const list = cards.map(c => { const k = this.card(c, cfg); k.days = k.last ? Math.floor((now - k.last) / DAY) : null; return k; });
      const week = this.sql.exec('SELECT COUNT(*) n FROM visits WHERE ts>?', now - 7 * DAY).toArray()[0].n;
      const { pinHash, waToken, waQr, ...pub } = cfg;
      return J({ cafe: { ...pub, waTokenSet: !!waToken }, stats: { customers: cards.length, visitsWeek: week, free: cards.reduce((a, c) => a + c.free, 0), redeemed: cards.reduce((a, c) => a + c.redeemed, 0) }, list, webhook: `/wa/${slug}` });
    }
    if (act === 'settings') {
      if (b.need) cfg.need = Math.max(3, Math.min(12, +b.need));
      for (const k of ['reward', 'waTemplate', 'waPhoneId', 'waTplName']) if (typeof b[k] === 'string' && b[k]) cfg[k] = b[k].slice(0, 500);
      if (typeof b.wa === 'string') cfg.wa = norm(b.wa);
      if (b.waToken) cfg.waToken = String(b.waToken);
      if (b.winbackDays) cfg.winbackDays = +b.winbackDays;
      if ('lat' in b) { cfg.lat = b.lat; cfg.lng = b.lng; }
      this.set('cfg', cfg); return J({ ok: true });
    }
    if (act === 'wa-status') return J({ enabled: !!cfg.waWeb, status: cfg.waStatus || 'off', qr: cfg.waWeb ? cfg.waQr || null : null, number: cfg.waNumber || '', at: cfg.waStatusAt || null });
    if (act === 'wa-enable') { cfg.waWeb = !!b.on; if (!b.on) { cfg.waQr = null; cfg.waStatus = 'off'; } this.set('cfg', cfg); return J({ ok: 1 }); }
    if (act === 'winback' && cfg.waWeb) {
      const c = this.sql.exec('SELECT * FROM cards WHERE id=?', b.id).toArray()[0]; if (!c) return J({ error: 'الكارت غير موجود' }, 404);
      const k = this.card(c, cfg), days = k.last ? Math.floor((Date.now() - k.last) / DAY) : 0;
      const text = cfg.waTemplate.replace('{name}', c.name).replace('{days}', days).replace('{cafe}', cfg.name).replace('{left}', cfg.need - c.stamps).replace('{reward}', cfg.reward);
      if (this.sql.exec("SELECT COUNT(*) n FROM outbox WHERE phone=? AND ts>? AND status IN ('pending','sent')", c.phone, Date.now() - 7 * DAY).toArray()[0].n) return J({ error: 'اتبعتله رسالة الأسبوع ده' }, 429);
      this.sql.exec("INSERT INTO outbox(phone,text,ts) VALUES(?,?,?)", c.phone.startsWith('0') ? '2' + c.phone : c.phone, text, Date.now());
      return J({ ok: true, queued: true });
    }
    if (act === 'winback') { // optional: send through WhatsApp Cloud API (needs the cafe's own credentials)
      const c = this.sql.exec('SELECT * FROM cards WHERE id=?', b.id).toArray()[0]; if (!c) return J({ error: 'الكارت غير موجود' }, 404);
      if (!cfg.waToken || !cfg.waPhoneId) return J({ error: 'واتساب الرسمي غير مربوط لهذا الكافيه' }, 400);
      const k = this.card(c, cfg), days = k.last ? Math.floor((Date.now() - k.last) / DAY) : 0;
      const text = cfg.waTemplate.replace('{name}', c.name).replace('{days}', days).replace('{cafe}', cfg.name).replace('{left}', cfg.need - c.stamps).replace('{reward}', cfg.reward);
      const payload = cfg.waTplName ? { messaging_product: 'whatsapp', to: c.phone.startsWith('0') ? '2' + c.phone : c.phone, type: 'template', template: { name: cfg.waTplName, language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: c.name }] }] } }
        : { messaging_product: 'whatsapp', to: c.phone.startsWith('0') ? '2' + c.phone : c.phone, type: 'text', text: { body: text } };
      const r = await fetch(`https://graph.facebook.com/v21.0/${cfg.waPhoneId}/messages`, { method: 'POST', headers: { authorization: 'Bearer ' + cfg.waToken, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return r.ok ? J({ ok: true }) : J({ error: 'واتساب رفض الرسالة: ' + (await r.text()).slice(0, 200) }, 502);
    }
    return J({ error: 'not found' }, 404);
  }
  // Called only by the WhatsApp bridge (Worker checks the shared secret first)
  async bridge(req, u, b) {
    const cfg = this.cfg(); if (!cfg) return J({ error: 'no cafe' }, 404);
    const op = u.pathname.slice(5), now = Date.now();
    if (op === 'state') return J({ enabled: !!cfg.waWeb, name: cfg.name });
    if (op === 'auth') {
      const k = u.searchParams.get('k');
      if (req.method === 'GET') { const r = this.sql.exec('SELECT v FROM wa_auth WHERE k=?', k).toArray()[0]; return r ? J({ v: r.v }) : J({ v: null }); }
      if (req.method === 'PUT') { this.sql.exec('INSERT OR REPLACE INTO wa_auth VALUES(?,?)', k, b.v); return J({ ok: 1 }); }
      if (k === '*') this.sql.exec('DELETE FROM wa_auth'); else this.sql.exec('DELETE FROM wa_auth WHERE k=?', k); return J({ ok: 1 });
    }
    if (op === 'status') { cfg.waStatus = b.status; cfg.waQr = b.qr || null; cfg.waNumber = b.number || cfg.waNumber || ''; cfg.waStatusAt = now; this.set('cfg', cfg); return J({ ok: 1 }); }
    if (op === 'outbox') {
      if (req.method === 'GET') {
        const sent = this.sql.exec("SELECT COUNT(*) n FROM outbox WHERE status='sent' AND ts>?", now - DAY).toArray()[0].n;
        if (sent >= 40) return J([]); // daily cap per number: protects the number from bans
        return J(this.sql.exec("SELECT id,phone,text FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").toArray());
      }
      this.sql.exec('UPDATE outbox SET status=?, ts=? WHERE id=?', b.ok ? 'sent' : 'failed', now, b.id); return J({ ok: 1 });
    }
    if (op === 'incoming') { // customer wrote to the cafe number -> reply with their card (only answers people who write first)
      const from = norm(b.from); const ph = from.startsWith('20') ? '0' + from.slice(2) : from;
      const c = this.sql.exec('SELECT * FROM cards WHERE phone=? OR phone=?', from, ph).toArray()[0];
      const link = `${b.origin}/` + (c ? 'card/' + c.id : 'c/' + cfg.slug);
      return J({ reply: c ? `أهلاً ${c.name} ☕ كارتك في ${cfg.name}: ${link}` : `أهلاً بيك في ${cfg.name} ☕ اعمل كارت الولاء من هنا: ${link}` });
    }
    return J({ error: 'bad op' }, 404);
  }
  // WhatsApp Cloud API webhook for this cafe: customer sends any message -> gets their card link back
  async whatsapp(req, u) {
    const cfg = this.cfg(); if (!cfg) return new Response('no', { status: 404 });
    if (req.method === 'GET') return u.searchParams.get('hub.verify_token') === cfg.waVerify ? new Response(u.searchParams.get('hub.challenge')) : new Response('forbidden', { status: 403 });
    const body = await req.json().catch(() => ({}));
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg && cfg.waToken && cfg.waPhoneId) {
      const from = msg.from; const ph = from.startsWith('20') ? '0' + from.slice(2) : from;
      let c = this.sql.exec('SELECT * FROM cards WHERE phone=? OR phone=?', from, ph).toArray()[0];
      const link = `${u.origin}/` + (c ? 'card/' + c.id : 'c/' + cfg.slug);
      const text = c ? `أهلاً ${c.name} ☕ كارتك في ${cfg.name}: ${link}` : `أهلاً بيك في ${cfg.name} ☕ اعمل كارت الولاء من هنا: ${link}`;
      await fetch(`https://graph.facebook.com/v21.0/${cfg.waPhoneId}/messages`, { method: 'POST', headers: { authorization: 'Bearer ' + cfg.waToken, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: from, type: 'text', text: { body: text } }) });
    }
    return new Response('ok');
  }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname;
    const stub = slug => env.CAFE.get(env.CAFE.idFromName(slug));
    if (p === '/api/qr') return new Response(await QR.toString(u.searchParams.get('t') || '', { type: 'svg', margin: 1, color: { dark: '#1c3d2e', light: '#0000' } }), { headers: { 'content-type': 'image/svg+xml' } });
    if (p === '/api/cafes' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (!b.name || !/^\d{4,8}$/.test(b.pin || '')) return J({ error: 'الاسم والرقم السري (4 إلى 8 أرقام) مطلوبين' }, 400);
      let base = b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cafe';
      for (let i = 0; i < 5; i++) {
        const slug = i ? base + '-' + hex(2) : base;
        const r = await stub(slug).fetch('https://do/__create', { method: 'POST', body: JSON.stringify({ ...b, slug }) });
        if (r.ok) { await env.CAFE.get(env.CAFE.idFromName('__registry')).fetch('https://do/__reg', { method: 'POST', body: JSON.stringify({ slug }) }); return J({ slug }); }
      }
      return J({ error: 'جرب اسم تاني' }, 409);
    }
    let m;
    if (p.startsWith('/api/bridge/')) {
      if (!env.BRIDGE_SECRET || req.headers.get('x-bridge') !== env.BRIDGE_SECRET) return J({ error: 'forbidden' }, 403);
      if (p === '/api/bridge/cafes') return env.CAFE.get(env.CAFE.idFromName('__registry')).fetch('https://do/__reg');
      if ((m = p.match(/^\/api\/bridge\/([\w-]+)\/(\w+)$/))) return stub(m[1]).fetch(new Request(`https://do/__b/${m[2]}${u.search}`, { method: req.method, body: req.method === 'GET' ? undefined : req.body }));
    }
    if ((m = p.match(/^\/api\/card\/(.+)-[a-f0-9]{8}$/))) return stub(m[1]).fetch(`https://do/api/cafe/${m[1]}/card?id=${p.split('/')[3]}`);
    if ((m = p.match(/^\/api\/cafe\/([\w-]+)(?:\/[\w-]+)?$/))) return stub(m[1]).fetch(new Request("https://do" + p, req));
    if ((m = p.match(/^\/wa\/([\w-]+)$/))) return stub(m[1]).fetch(new Request(`https://do/__wa/${m[1]}${u.search}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? req.body : undefined }));
    if (p === '/manifest.json') return new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } });
    if (p === '/icon.svg') return new Response(icon, { headers: { 'content-type': 'image/svg+xml' } });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
};

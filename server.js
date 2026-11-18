// Read-only stats dashboard. No dependencies. Secrets come from env only.
// STRIPE_KEY  restricted read-only Stripe key (never sent to the browser)
// TOKEN       secret path segment guarding the page and data
// DB_TOKEN    secret passed to the Supabase dash_get() function
// SB_URL, SB_ANON  Supabase project URL and public anon key
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { STRIPE_KEY, TOKEN, DB_TOKEN, SB_URL, SB_ANON } = process.env;
const PORT = process.env.PORT || 3000;
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function stripeList(endpoint, params, maxPages = 5) {
  const out = [];
  let after = null;
  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams(params);
    q.set('limit', '100');
    if (after) q.set('starting_after', after);
    const r = await fetch('https://api.stripe.com/v1/' + endpoint + '?' + q, {
      headers: { Authorization: 'Bearer ' + STRIPE_KEY }
    });
    if (!r.ok) throw new Error('stripe ' + endpoint + ' ' + r.status);
    const j = await r.json();
    out.push(...j.data);
    if (!j.has_more) break;
    after = j.data[j.data.length - 1].id;
  }
  return out;
}

// Blue Hour payment-link URL slugs -> Stripe payment_link ids (cached hourly).
const BH_SLUGS = ['aFa8wJ3BN2t2djn5z073G03', '00wbIVfkv8Rq6UZ4uW73G04'];
let plinkCache = { at: 0, ids: null };
async function bluehourLinkIds() {
  if (plinkCache.ids && Date.now() - plinkCache.at < 3600000) return plinkCache.ids;
  try {
    const links = await stripeList('payment_links', {}, 2);
    const ids = new Set();
    for (const l of links) {
      const slug = (l.url || '').split('/').pop();
      if (BH_SLUGS.indexOf(slug) > -1) ids.add(l.id);
    }
    plinkCache = { at: Date.now(), ids };
  } catch (e) { /* keep previous (or null -> description matching only) */ }
  return plinkCache.ids;
}

function productOf(s, bhIds) {
  const d = ((s.line_items && s.line_items.data || []).map(i => i.description || '').join(' ')).toLowerCase();
  if (d.includes('counterpack')) return 'counterpack';
  if (d.includes('sheetcheck')) return 'sheetcheck';
  if (d.includes('blue hour') || d.includes('bluehour') || d.includes('crab') || d.includes('seauto')) return 'bluehour';
  if (bhIds && s.payment_link && bhIds.has(s.payment_link)) return 'bluehour';
  return 'other';
}

async function stripeStats() {
  const sessions = await (async () => {
    const out = []; let after = null;
    for (let i = 0; i < 5; i++) {
      const q = new URLSearchParams(); q.set('limit', '100'); q.append('expand[]', 'data.line_items');
      if (after) q.set('starting_after', after);
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions?' + q, { headers: { Authorization: 'Bearer ' + STRIPE_KEY } });
      if (!r.ok) throw new Error('stripe sessions ' + r.status);
      const j = await r.json(); out.push(...j.data);
      if (!j.has_more) break; after = j.data[j.data.length - 1].id;
    }
    return out;
  })();
  const charges = await stripeList('charges', {}, 5);
  const refunded = {};
  for (const c of charges) if (c.payment_intent) refunded[c.payment_intent] = (refunded[c.payment_intent] || 0) + (c.amount_refunded || 0);
  const bhIds = await bluehourLinkIds();

  const prod = {};
  for (const k of ['counterpack', 'sheetcheck', 'bluehour', 'other']) prod[k] = { opened: 0, paid: 0, rev: {}, ref: {} };
  const recent = [];
  for (const s of sessions) {
    const p = productOf(s, bhIds);
    const paid = s.payment_status === 'paid';
    prod[p].opened++;
    let ref = 0;
    const cur = s.currency || 'usd';
    if (paid) {
      prod[p].paid++;
      prod[p].rev[cur] = (prod[p].rev[cur] || 0) + (s.amount_total || 0);
      ref = refunded[s.payment_intent] || 0;
      prod[p].ref[cur] = (prod[p].ref[cur] || 0) + ref;
    }
    if (p !== 'other') recent.push({
      t: s.created, product: p, cents: s.amount_total || 0, currency: cur,
      state: paid ? (ref >= (s.amount_total || 1) ? 'refunded' : 'paid') : (s.status === 'open' ? 'open' : 'not completed')
    });
  }
  recent.sort((a, b) => b.t - a.t);
  return { products: prod, recent: recent.slice(0, 15), sessions_scanned: sessions.length };
}

async function dbStats() {
  if (!SB_URL || !SB_ANON || !DB_TOKEN) return null;
  const r = await fetch(SB_URL + '/rest/v1/rpc/dash_get', {
    method: 'POST',
    headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: DB_TOKEN })
  });
  if (!r.ok) throw new Error('db ' + r.status);
  return await r.json();
}

let cache = { at: 0, data: null };
async function build() {
  if (cache.data && Date.now() - cache.at < 60000) return cache.data;
  const out = { generated_at: Math.floor(Date.now() / 1000), errors: [] };
  try { out.stripe = await stripeStats(); } catch (e) { out.errors.push('Sales data unavailable right now'); }
  try { out.db = await dbStats(); } catch (e) { out.errors.push('Page view data unavailable right now'); }
  if (!out.errors.length) cache = { at: Date.now(), data: out };
  return out;
}

http.createServer(async (req, res) => {
  const hdr = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const url = (req.url || '').split('?')[0];
  const m = url.match(/^\/d\/([^/]+)(\/data)?\/?$/);
  if (!TOKEN || !m || !safeEq(m[1], TOKEN)) {
    res.writeHead(404, { ...hdr, 'Content-Type': 'text/plain' }); return res.end('Not found');
  }
  if (m[2]) {
    const d = await build();
    res.writeHead(200, { ...hdr, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(d));
  }
  res.writeHead(200, { ...hdr, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'" });
  res.end(HTML);
}).listen(PORT, () => console.log('listening ' + PORT));

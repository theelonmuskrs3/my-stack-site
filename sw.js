/* My Stack! — passcode-locked service worker. Decrypts the app on-device after unlock. */
const BASE = '/my-stack-site';
const FN = '/_serverFn/5401c5282e57c3fe7ac93ddd414cfb32a3caefd3c278ec301db73c47acc41f7b';
const SW_VERSION = '2026-11-14-sync2'; // bump to make phones pick up a new worker
const ENC_CACHE = 'mystack-enc-v2';
const TYPES = { js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon', webmanifest: 'application/manifest+json; charset=utf-8', html: 'text/html; charset=utf-8' };
const METALS = { gold: ['AU', 5600], silver: ['AG', 0], platinum: ['PT', 0], palladium: ['PD', 3400] };
let KEY = null, MAP = null, MAP_SIG = '', TEMPLATE = null, SPOTS = null, SPOTS_AT = 0;
const mem = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => { for (const k of await caches.keys()) if (k.startsWith('mystack-enc-') && k !== ENC_CACHE) await caches.delete(k); await self.clients.claim(); })()));
self.addEventListener('message', e => { if (e.data === 'lock') { KEY = null; MAP = null; TEMPLATE = null; mem.clear(); } });

function idb() { return new Promise((res, rej) => { const r = indexedDB.open('mystack-lock', 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function loadKey() {
  if (KEY) return KEY;
  const db = await idb();
  KEY = await new Promise(res => { const g = db.transaction('k').objectStore('k').get('aes'); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); });
  return KEY;
}
async function encBytes(name) {
  const url = BASE + '/enc/' + name;
  const c = await caches.open(ENC_CACHE);
  try { const r = await fetch(url, { cache: 'no-cache' }); if (r.ok) { c.put(url, r.clone()); return new Uint8Array(await r.arrayBuffer()); } } catch (e) {}
  const hit = await c.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer());
  throw new Error('missing ' + name);
}
async function decrypt(name) {
  const key = await loadKey(); if (!key) throw new Error('locked');
  const b = await encBytes(name);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12)));
}
async function getMap() { if (!MAP) MAP = JSON.parse(new TextDecoder().decode(await decrypt('map.bin'))); return MAP; }
// network-first refresh of the encrypted file map; a new publish => drop everything decrypted in memory
let MAP_P = null;
function refreshMap() { // concurrent callers share one in-flight refresh
  if (!MAP_P) MAP_P = (async () => {
    const b = await encBytes('map.bin'); const sig = Array.from(b.slice(0, 16)).join(',');
    if (sig !== MAP_SIG || !MAP) { const key = await loadKey(); if (!key) throw new Error('locked');
      const m = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12))));
      TEMPLATE = null; mem.clear(); MAP = m; MAP_SIG = sig; }
    return MAP;
  })().finally(() => { MAP_P = null; });
  return MAP_P;
}
async function holdingsPayload() { const map = await refreshMap(); return JSON.parse(new TextDecoder().decode(await decrypt(map['/__holdings.json']))); }

// ---- spot data (same logic as the original server function) ----
const etDay = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
async function kitco(sym) {
  const r = await fetch(`https://proxy.kitco.com/getPM?symbol=${sym}&currency=USD`, { cache: 'no-store' });
  const p = (await r.text()).trim().split(',');
  if (p.length < 9 || !isFinite(+p[5])) throw new Error('kitco');
  return { asOf: Date.parse(p[3].replace(' ', 'T') + '-04:00'), spot: +p[5], changePct: +p[8] / 100 };
}
async function history() {
  const url = BASE + '/data/history.json'; const c = await caches.open(ENC_CACHE);
  try { const r = await fetch(url, { cache: 'no-cache' }); if (r.ok) { c.put(url, r.clone()); return r.json(); } } catch (e) {}
  const hit = await c.match(url); if (hit) return hit.json(); throw new Error('history');
}
// ---- recent daily bars after the bundled Yahoo history: fawazahmed0/currency-api ----
// Free, keyless, CORS-enabled, documented at https://github.com/fawazahmed0/exchange-api
// The file dated D+1 holds rates taken ~00:00 UTC on D+1, i.e. the evening close of D (ET).
const FX = { gold: 'xau', silver: 'xag', platinum: 'xpt', palladium: 'xpd' };
const FX_CACHE = 'mystack-fx-v1';
const fxUrls = day => [`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.min.json`, `https://${day}.currency-api.pages.dev/v1/currencies/usd.min.json`];
async function fxDay(day, immutable = true) {
  const c = await caches.open(FX_CACHE); const k = 'https://fx.local/' + day;
  if (immutable) { const hit = await c.match(k); if (hit) return hit.json(); }
  for (const u of fxUrls(day)) {
    try { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) continue; const j = await r.json(); if (!j || !j.usd) continue;
      if (immutable) c.put(k, new Response(JSON.stringify(j))); return j; } catch (e) {}
  }
  return null;
}
const ymd = d => d.toISOString().slice(0, 10);
const etMidnight = day => { // midnight America/New_York on calendar day `day` (YYYY-MM-DD), like Yahoo's daily bar stamps
  const [y, m, d] = day.split('-').map(Number); const utcNoon = Date.UTC(y, m - 1, d, 12);
  const off = new Date(utcNoon).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)/);
  return Date.UTC(y, m - 1, d, -(off ? +off[1] : -5));
};
async function recentBars(lastBundledT, asOf) {
  const out = { gold: [], silver: [], platinum: [], palladium: [] };
  const start = new Date(etDay(lastBundledT) + 'T12:00:00Z'); start.setUTCDate(start.getUTCDate() + 1);
  const endDay = etDay(asOf); const days = [];
  for (let d = new Date(start); ymd(d) < endDay && days.length < 400; d.setUTCDate(d.getUTCDate() + 1)) { const wd = d.getUTCDay(); if (wd >= 1 && wd <= 5) days.push(ymd(d)); }
  const todayUtc = ymd(new Date());
  const results = new Array(days.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(6, days.length) }, async () => { while (i < days.length) { const j = i++; const next = new Date(days[j] + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1); const nd = ymd(next); results[j] = nd > todayUtc ? null : await fxDay(nd, nd < todayUtc); } }));
  days.forEach((day, j) => { const r = results[j]; if (!r) return; for (const m in FX) { const v = r.usd[FX[m]]; if (v > 0) out[m].push({ t: etMidnight(day), spot: 1 / v }); } });
  return out;
}
function despike(bars, prev, next) { // drop isolated one-day glitches (> 10% away from both neighbours that agree with each other)
  return bars.filter((b, i) => { const a = i ? bars[i - 1].spot : prev, c = i < bars.length - 1 ? bars[i + 1].spot : next;
    if (!(a > 0 && c > 0)) return true; const da = b.spot / a - 1, dc = b.spot / c - 1;
    return !(Math.abs(da) > 0.1 && Math.abs(dc) > 0.1 && Math.sign(da) === Math.sign(dc) && Math.abs(a / c - 1) < 0.1); })
    .filter((b, i, arr) => !i || b.spot !== arr[i - 1].spot); // stale holiday repeats
}
async function getSpots() {
  if (SPOTS && Date.now() - SPOTS_AT < 60000) return SPOTS;
  const h = await history(); const names = Object.keys(METALS);
  let ks = await Promise.all(names.map(n => kitco(METALS[n][0]).catch(() => null)));
  if (ks.some(k => !k)) { // spot fallback: currency-api latest
    const L = await fxDay('latest', false);
    if (L) ks = ks.map((k, i) => k || { spot: 1 / L.usd[FX[names[i]]], asOf: Date.parse(L.date + 'T00:00:00Z'), changePct: 0 });
  }
  const asOf0 = (ks[0] && ks[0].asOf) || h.gold.last.time;
  const lastT = Math.max(...names.map(n => h[n].history[h[n].history.length - 1][0]));
  let recent = { gold: [], silver: [], platinum: [], palladium: [] };
  try { recent = await recentBars(lastT, asOf0); } catch (e) {}
  const out = {};
  names.forEach((n, i) => {
    const k = ks[i], d = h[n];
    const spot = k ? k.spot : d.last.price, asOf = k ? k.asOf : d.last.time;
    const changePct = k ? k.changePct : d.last.price / d.last.prevClose - 1;
    const base = d.history.map(([t, s]) => ({ t, spot: s }));
    const extra = despike(recent[n].filter(b => b.t > base[base.length - 1].t), base[base.length - 1].spot, spot);
    const hist = base.concat(extra).filter(p => etDay(p.t) !== etDay(asOf) && p.t < asOf);
    hist.push({ t: asOf, spot });
    out[n] = { spotUsd: spot, athUsd: Math.max(d.high, METALS[n][1], spot, ...extra.map(b => b.spot)), changePct, history: hist };
  });
  out.asOf = asOf0; out.source = 'Kitco';
  SPOTS = out; SPOTS_AT = Date.now(); return out;
}
function toSSR(d) {
  let id = 13; let s = `$R[${id++}]={`;
  const parts = Object.keys(METALS).map(m => { const x = d[m];
    let str = `${m}:$R[${id++}]={spotUsd:${x.spotUsd},athUsd:${x.athUsd},changePct:${x.changePct},history:$R[${id++}]=[`;
    return str + x.history.map(p => `$R[${id++}]={t:${p.t},spot:${p.spot}}`).join(',') + ']}'; });
  return s + parts.join(',') + `,asOf:${d.asOf},source:${JSON.stringify(d.source)}}`;
}
function toJSON(d) {
  let id = 0; const n = v => ({ t: 0, s: v }); const o = (k, v, i) => ({ t: 10, i, p: { k, v }, o: 0 });
  const rootId = id++, resId = id++;
  const ms = Object.keys(METALS).map(m => { const x = d[m]; const mi = id++, ai = id++;
    const items = x.history.map(p => o(['t', 'spot'], [n(p.t), n(p.spot)], id++));
    return o(['spotUsd', 'athUsd', 'changePct', 'history'], [n(x.spotUsd), n(x.athUsd), n(x.changePct), { t: 9, i: ai, a: items, o: 0 }], mi); });
  const res = o(['gold', 'silver', 'platinum', 'palladium', 'asOf', 'source'], [...ms, n(d.asOf), { t: 1, s: d.source }], resId);
  return JSON.stringify(o(['result', 'error', 'context'], [res, { t: 2, s: 1 }, { t: 11, i: id++, p: { k: [], v: [] }, o: 0 }], rootId));
}
async function appPage() {
  const map = await refreshMap();
  if (!TEMPLATE) TEMPLATE = new TextDecoder().decode(await decrypt(map['/__app.html']));
  const hold = await holdingsPayload();
  let data = 'null'; try { data = toSSR(await getSpots()); } catch (e) {}
  const html = TEMPLATE.replace('l:__LOADER_DATA__', 'l:' + data).replaceAll('u:__NOW__', 'u:' + Date.now())
    .replace('__MYSTACK_HOLDINGS_JSON__', () => JSON.stringify(hold).replace(/</g, '\\u003c'));
  return new Response(html, { headers: { 'content-type': TYPES.html, 'cache-control': 'no-store' } });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(BASE + '/')) return;
  const p = url.pathname;
  if (/\/(icons\/|__grok\/|favicon|manifest)[^/]*$/.test(p) || /\.(webmanifest|png|ico|svg)$/.test(p) && !/^\/(assets|holdings|textures)\//.test(p.slice(BASE.length))) {
    e.respondWith(fetch(e.request, { cache: 'no-cache' })); return; // icons & manifests: always revalidate with the network
  }
  if (e.request.mode === 'navigate' && (p === BASE + '/' || p === BASE + '/index.html')) {
    e.respondWith((async () => { if (await loadKey()) { try { return await appPage(); } catch (err) { console.error(err); } } return fetch(e.request).catch(() => caches.match(BASE + '/index.html')); })());
    return;
  }
  if (p === BASE + '/__rev') {
    e.respondWith((async () => { if (!(await loadKey())) return new Response('Locked', { status: 403 });
      try { const h = await holdingsPayload(); return new Response(JSON.stringify({ rev: h.rev }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
      catch (err) { return new Response('{}', { status: 503 }); } })());
    return;
  }
  if (p === BASE + FN) {
    e.respondWith((async () => { if (!(await loadKey())) return new Response('Locked', { status: 403 });
      return new Response(toJSON(await getSpots()), { headers: { 'content-type': 'application/json', 'x-tss-serialized': 'true' } }); })());
    return;
  }
  if (e.request.method === 'GET' && /^\/(assets|holdings|textures)\//.test(p.slice(BASE.length))) {
    e.respondWith((async () => {
      if (!(await loadKey())) return new Response('Locked', { status: 403 });
      const map = await getMap(); const name = map[p.slice(BASE.length)];
      if (!name) return new Response('Not found', { status: 404 });
      let bytes = mem.get(name); if (!bytes) { bytes = await decrypt(name); mem.set(name, bytes); }
      return new Response(bytes, { headers: { 'content-type': TYPES[p.split('.').pop()] || 'application/octet-stream' } });
    })());
  }
});

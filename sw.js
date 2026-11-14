/* My Stack! — passcode-locked service worker. Decrypts the app on-device after unlock. */
const BASE = '/my-stack-site';
const FN = '/_serverFn/5401c5282e57c3fe7ac93ddd414cfb32a3caefd3c278ec301db73c47acc41f7b';
const ENC_CACHE = 'mystack-enc-v1';
const TYPES = { js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon', webmanifest: 'application/manifest+json; charset=utf-8', html: 'text/html; charset=utf-8' };
const METALS = { gold: ['AU', 5600], silver: ['AG', 0], platinum: ['PT', 0], palladium: ['PD', 3400] };
let KEY = null, MAP = null, TEMPLATE = null, SPOTS = null, SPOTS_AT = 0;
const mem = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
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
async function getSpots() {
  if (SPOTS && Date.now() - SPOTS_AT < 60000) return SPOTS;
  const h = await history(); const names = Object.keys(METALS);
  const ks = await Promise.all(names.map(n => kitco(METALS[n][0]).catch(() => null)));
  const out = {}; let asOf0;
  names.forEach((n, i) => {
    const k = ks[i], d = h[n];
    const spot = k ? k.spot : d.last.price, asOf = k ? k.asOf : d.last.time;
    const changePct = k ? k.changePct : d.last.price / d.last.prevClose - 1;
    const hist = d.history.filter(([t]) => etDay(t) !== etDay(asOf) && t < asOf).map(([t, s]) => ({ t, spot: s }));
    hist.push({ t: asOf, spot });
    out[n] = { spotUsd: spot, athUsd: Math.max(d.high, METALS[n][1], spot), changePct, history: hist };
    if (i === 0) asOf0 = asOf;
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
  if (!TEMPLATE) TEMPLATE = new TextDecoder().decode(await decrypt((await getMap())['/__app.html']));
  let data = 'null'; try { data = toSSR(await getSpots()); } catch (e) {}
  const html = TEMPLATE.replace('l:__LOADER_DATA__', 'l:' + data).replaceAll('u:__NOW__', 'u:' + Date.now());
  return new Response(html, { headers: { 'content-type': TYPES.html, 'cache-control': 'no-store' } });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(BASE + '/')) return;
  const p = url.pathname;
  if (e.request.mode === 'navigate' && (p === BASE + '/' || p === BASE + '/index.html')) {
    e.respondWith((async () => { if (await loadKey()) { try { return await appPage(); } catch (err) { console.error(err); } } return fetch(e.request).catch(() => caches.match(BASE + '/index.html')); })());
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

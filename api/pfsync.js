// Cloud save for the portfolio page: wallets, names and bundles stored under a private random id.
//   POST /api/pfsync { id?, state }  -> { id }        (no id = create a new one)
//   GET  /api/pfsync?id=...           -> { state }
// Anyone with the id (the sync link) can read and update that list, so the id is long and random.
const crypto = require('crypto');
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const mem = globalThis.__pfsync || (globalThis.__pfsync = {});
const TTL = 400 * 86400; // kept for ~a year after the last save

async function redis(...cmds) {
  const r = await fetch(RURL + '/pipeline', { method: 'POST', headers: { authorization: 'Bearer ' + RTOK, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => x.result);
}
function body(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise(res => { let s = ''; req.on('data', c => { s += c; if (s.length > 40000) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(s)); } catch { res({}); } }); });
}
function send(res, code, obj) { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(obj)); }

// keep only what the page uses, so the store can't be used for anything else
const ADDR = /^0x[0-9a-f]{64}$/;
function clean(s) {
  const wallets = (Array.isArray(s?.wallets) ? s.wallets : []).filter(w => ADDR.test(w?.a)).slice(0, 100).map(w => ({ a: w.a, label: String(w.label || '').slice(0, 20) }));
  const known = new Set(wallets.map(w => w.a));
  const bundles = (Array.isArray(s?.bundles) ? s.bundles : []).slice(0, 30).map(b => ({ id: String(b.id || '').replace(/[^\w-]/g, '').slice(0, 16), name: String(b.name || 'Bundle').slice(0, 24), wallets: (Array.isArray(b.wallets) ? b.wallets : []).filter(a => known.has(a)) })).filter(b => b.id);
  return { wallets, bundles };
}

module.exports = async (req, res) => {
  try {
    if (!RURL && process.env.VERCEL) return send(res, 503, { error: 'store not configured' });
    if (req.method === 'GET') {
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      if (!/^[A-Za-z0-9]{20,40}$/.test(id)) return send(res, 400, { error: 'bad id' });
      const raw = RURL ? (await redis(['GET', 'pf:sync:' + id]))[0] : mem[id];
      return raw ? send(res, 200, { state: JSON.parse(raw) }) : send(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST') {
      const b = await body(req);
      let id = String(b.id || '');
      if (!/^[A-Za-z0-9]{20,40}$/.test(id)) id = crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 24).padEnd(24, 'x');
      const raw = JSON.stringify(clean(b.state));
      if (RURL) await redis(['SET', 'pf:sync:' + id, raw, 'EX', TTL]); else mem[id] = raw;
      return send(res, 200, { id });
    }
    send(res, 405, { error: 'method' });
  } catch (e) {
    send(res, 500, { error: 'store unavailable' });
  }
};

// GeckoTerminal proxy for the home page chart / market cap. Browsers calling GeckoTerminal directly hit its ~30
// calls/min limit, and its 429 replies have no CORS header, so the page just showed nothing. Here every visitor
// shares one Redis cache, and when GeckoTerminal says "slow down" we serve the last good copy instead.
//   GET /api/gt?u=networks/starknet-alpha/pools/0x…[/ohlcv/day?aggregate=1&limit=1000&currency=usd]
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const mem = globalThis.__gt || (globalThis.__gt = {});
// only Starknet pool / token data, so this can't be used as an open proxy
const OK = /^networks\/starknet-alpha\/(pools|tokens)\/0x[0-9a-fA-F]{1,64}(\/ohlcv\/(minute|hour|day))?(\?(aggregate=\d{1,3}|limit=\d{1,4}|currency=(usd|token)|&)*)?$/;

async function redis(...cmds) {
  if (!RURL) return cmds.map(([c, k, v]) => { if (c === 'GET') return mem[k] ?? null; if (c === 'SET') { mem[k] = v; return 'OK'; } return null; });
  const r = await fetch(RURL + '/pipeline', { method: 'POST', headers: { authorization: 'Bearer ' + RTOK, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  return r.ok ? (await r.json()).map(x => x.result) : cmds.map(() => null);
}
function send(res, code, body, age) {
  res.statusCode = code; res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', code === 200 ? `public, s-maxage=${age}, stale-while-revalidate=300` : 'no-store'); // Vercel's CDN shares it too
  res.end(body);
}

module.exports = async (req, res) => {
  const u = new URL(req.url, 'http://x').searchParams.get('u') || '';
  if (!OK.test(u)) return send(res, 400, '{"error":"not allowed"}', 0);
  const ttl = /\/ohlcv\/(minute|hour)/.test(u) ? 60 : /\/ohlcv\//.test(u) ? 120 : 30, key = 'gt:' + u;
  try {
    const [cached] = await redis(['GET', key]).catch(() => [null]);
    if (cached) { const c = JSON.parse(cached); if (Date.now() - c.at < ttl * 1000) return send(res, 200, c.body, ttl); }
    const r = await fetch('https://api.geckoterminal.com/api/v2/' + u, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const body = await r.text();
      await redis(['SET', key, JSON.stringify({ at: Date.now(), body }), 'EX', 86400]).catch(() => {}); // kept a day as the fallback
      return send(res, 200, body, ttl);
    }
    if (cached) return send(res, 200, JSON.parse(cached).body, 15); // rate limited / down: last good copy
    send(res, 502, '{"error":"price feed busy, try again shortly"}', 0);
  } catch {
    send(res, 502, '{"error":"price feed unavailable"}', 0);
  }
};

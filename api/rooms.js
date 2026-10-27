// Open (public) kart rooms. Hosts check in every few seconds; a room that stops checking in drops off the list.
//   GET  /api/rooms                         -> { rooms: [{ code, host, map, mode, laps, mins, players, target, status }] }
//   POST /api/rooms { code, host, map, ... } -> keep the room listed for another 15 s
//   POST /api/rooms { code, close: true }   -> unlist it now
// Same Upstash store as the leaderboards; falls back to process memory for local dev.
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 15;
const mem = globalThis.__kartRooms || (globalThis.__kartRooms = {});
const MAPS = ['bonfire', 'pit', 'night', 'halloween', 'chain', 'degenz'];

async function redis(...cmds) {
  const r = await fetch(RURL + '/pipeline', { method: 'POST', headers: { authorization: 'Bearer ' + RTOK, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => x.result);
}
const clean = (v, max) => String(v || '').replace(/[^\w .$-]/g, '').trim().slice(0, max);
const int = (v, lo, hi, d) => { v = +v; return Number.isInteger(v) && v >= lo && v <= hi ? v : d; };
function body(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise(res => { let s = ''; req.on('data', c => { s += c; if (s.length > 2000) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(s)); } catch { res({}); } }); });
}
function send(res, code, obj) { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(obj)); }

async function list() {
  const now = Date.now();
  if (!RURL) { for (const [c, r] of Object.entries(mem)) if (r.exp < now) delete mem[c]; return Object.values(mem).map(({ exp, ...r }) => r); }
  const [, codes] = await redis(['ZREMRANGEBYSCORE', 'kart:rooms', 0, now - TTL * 1000], ['ZRANGEBYSCORE', 'kart:rooms', now - TTL * 1000, '+inf']);
  if (!codes.length) return [];
  const [vals] = await redis(['MGET', ...codes.map(c => 'kart:room:' + c)]);
  return vals.filter(Boolean).map(v => JSON.parse(v));
}

module.exports = async (req, res) => {
  try {
    if (!RURL && process.env.VERCEL) return send(res, 503, { error: 'store not configured' });
    if (req.method === 'GET') {
      const rooms = (await list()).sort((a, b) => (a.status === 'waiting' ? 0 : 1) - (b.status === 'waiting' ? 0 : 1) || b.players - a.players).slice(0, 30);
      return send(res, 200, { rooms });
    }
    if (req.method === 'POST') {
      const b = await body(req), code = String(b.code || '').toUpperCase();
      if (!/^[A-Z0-9]{5}$/.test(code)) return send(res, 400, { error: 'bad code' });
      if (b.close) {
        if (!RURL) delete mem[code]; else await redis(['DEL', 'kart:room:' + code], ['ZREM', 'kart:rooms', code]);
        return send(res, 200, { ok: true });
      }
      const room = {
        code, host: clean(b.host, 14) || 'HOST', map: MAPS.includes(b.map) ? b.map : 'bonfire', mode: b.mode === 'arena' ? 'arena' : 'race',
        laps: int(b.laps, 1, 9, 3), mins: int(b.mins, 1, 10, 3), players: int(b.players, 1, 12, 1), target: int(b.target, 2, 12, 4),
        status: b.status === 'racing' ? 'racing' : 'waiting', at: Date.now(),
      };
      if (!RURL) mem[code] = { ...room, exp: Date.now() + TTL * 1000 };
      else await redis(['SET', 'kart:room:' + code, JSON.stringify(room), 'EX', TTL], ['ZADD', 'kart:rooms', Date.now(), code]);
      return send(res, 200, { ok: true });
    }
    send(res, 405, { error: 'method' });
  } catch (e) {
    send(res, 500, { error: 'store unavailable' });
  }
};

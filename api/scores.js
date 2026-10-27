// Global high scores for Degenz Kart.
//   GET  /api/scores?board=race3        -> { board, top: [{ name, score, coin, img, at }] }
//   POST /api/scores { board, name, score, coin, img }
// Boards: race<laps> (fastest finish, lower is better) and arena<mins> (most kills, higher is better).
// Stored in Upstash Redis over its REST API (env from the Vercel Upstash / KV integration); without those env
// vars it falls back to process memory so local dev works.
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TOP = 10;
const mem = globalThis.__kartScores || (globalThis.__kartScores = {});

async function redis(...cmds) {
  const r = await fetch(RURL + '/pipeline', { method: 'POST', headers: { authorization: 'Bearer ' + RTOK, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => x.result);
}

// board name = map key + laps (race maps) or minutes (arena maps); 'race' / 'arena' are Bonfire Bay / The Pit
const KIND = { race: 'race', night: 'race', halloween: 'race', chain: 'race', arena: 'arena', degenz: 'arena' };
function parseBoard(b) {
  const m = /^([a-z]+)(\d{1,2})$/.exec(String(b || ''));
  if (!m || !KIND[m[1]]) return null;
  const n = +m[2], kind = KIND[m[1]];
  if (kind === 'race' ? n < 1 || n > 9 : n < 1 || n > 10) return null;
  return { id: m[0], kind, n, low: kind === 'race' };
}
// throw out scores no real driver could set
function plausible(bd, s) {
  if (!Number.isFinite(s)) return false;
  return bd.kind === 'race' ? s >= 15 * bd.n && s <= 900 * bd.n : Number.isInteger(s) && s >= 1 && s <= 25 * bd.n;
}
const clean = (v, max) => String(v || '').replace(/[^\w .$-]/g, '').trim().slice(0, max);

async function top(bd) {
  if (!RURL) {
    const rows = Object.values(mem[bd.id] || {}).sort((a, b) => bd.low ? a.score - b.score : b.score - a.score);
    return rows.slice(0, TOP);
  }
  const key = 'kart:' + bd.id;
  const [z] = await redis(bd.low ? ['ZRANGE', key, 0, TOP - 1, 'WITHSCORES'] : ['ZRANGE', key, 0, TOP - 1, 'REV', 'WITHSCORES']);
  const names = [], scores = [];
  for (let i = 0; i < z.length; i += 2) { names.push(z[i]); scores.push(+z[i + 1]); }
  if (!names.length) return [];
  const [meta] = await redis(['HMGET', key + ':meta', ...names]);
  return names.map((name, i) => ({ name, score: scores[i], ...(meta[i] ? JSON.parse(meta[i]) : {}) }));
}

async function submit(bd, row) {
  if (!RURL) {
    const b = (mem[bd.id] ||= {}), prev = b[row.name.toLowerCase()];
    if (!prev || (bd.low ? row.score < prev.score : row.score > prev.score)) b[row.name.toLowerCase()] = row;
    return;
  }
  // one entry per name, only replaced when it's a better score (LT for times, GT for kills)
  const key = 'kart:' + bd.id;
  const [changed] = await redis(['ZADD', key, bd.low ? 'LT' : 'GT', 'CH', row.score, row.name]);
  if (changed) await redis(['HSET', key + ':meta', row.name, JSON.stringify({ coin: row.coin, img: row.img, at: row.at })]);
  // keep the boards small
  await redis(bd.low ? ['ZREMRANGEBYRANK', key, 200, -1] : ['ZREMRANGEBYRANK', key, 0, -201]);
}

function body(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise(res => { let s = ''; req.on('data', c => { s += c; if (s.length > 4000) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(s)); } catch { res({}); } }); });
}
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  try {
    // on Vercel, memory doesn't persist between requests: report offline until the Redis store is connected
    if (!RURL && process.env.VERCEL) return send(res, 503, { error: 'store not configured' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET') {
      const bd = parseBoard(url.searchParams.get('board'));
      if (!bd) return send(res, 400, { error: 'bad board' });
      return send(res, 200, { board: bd.id, top: await top(bd) });
    }
    if (req.method === 'POST') {
      const b = await body(req), bd = parseBoard(b.board);
      const score = bd && (bd.kind === 'race' ? Math.round(+b.score * 100) / 100 : +b.score);
      const name = clean(b.name, 14);
      if (!bd || !name || !plausible(bd, score)) return send(res, 400, { error: 'rejected' });
      const img = typeof b.img === 'string' && b.img.length < 300 && /^(\/|https:\/\/)[\w./:%?=&-]+$/.test(b.img) ? b.img : '';
      await submit(bd, { name, score, coin: clean(b.coin, 24), img, at: Date.now() });
      return send(res, 200, { board: bd.id, top: await top(bd) });
    }
    send(res, 405, { error: 'method' });
  } catch (e) {
    send(res, 500, { error: 'store unavailable' });
  }
};

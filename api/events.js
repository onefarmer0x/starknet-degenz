// Degenz Kart tournaments: races booked for a set time with a set number of human players.
//
// An event is a stored record (it outlives any browser). The race itself still runs peer-to-peer in a player's
// browser: when doors open, the first player to arrive hosts the room and reports its code here, everyone else
// with the link joins that room, and if the host drops out the next player re-hosts. Nothing is ever deleted by
// hand: every stage has an end time and Redis drops the data when it passes.
//
//   GET  /api/events?list=1              -> { events: [...] }            upcoming and open events
//   GET  /api/events?id=ABC123           -> event (with its live status)
//   GET  /api/events?card=ABC123         -> 1200×630 PNG card for X / link previews
//   GET  /api/events?share=ABC123        -> tiny HTML page with the card as og:image, then on to the race page
//                                           (vercel.json maps /e/<id> here, so that's the link people share)
//   POST { create: { title, at, tz, players, map, laps, mins } }   (signed in)  -> event
//   POST { cancel: id }                  (the creator, before it opens)
//   POST { room: id, code, players }     host heartbeat while the room is up  -> { room } (the room everyone should join)
//   POST { room: id, code, leave: true } the host is leaving: free the slot so the next player re-hosts at once
//   POST { results: id, code, order }    the host, once, when the race ends
//   POST { report: id, code, slot, finished, time, kills }   every player's own result, to check the host's
//
// Results settle themselves by fixed rules, with nobody approving anything. Each player's browser drives its own
// kart (the host only relays it), so each player's own report is the source for their own time or kills, and the
// host can't change anyone else's result. A time faster than physically possible (15 s a lap, or 85% of the map's
// world record) is disqualified automatically. A player whose report never arrives falls back to the host's record.
// The standings are rebuilt from those numbers.
//
// Status: scheduled (until 10 min before) -> open (until 15 min after the start, or until results) -> finished |
// expired (nobody played) | cancelled. Records expire 7 days after the start time.
const crypto = require('crypto');
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SITE = (process.env.SITE_URL || 'https://www.starknetdegenz.fun').replace(/\/+$/, '');
const mem = globalThis.__pfauth || (globalThis.__pfauth = { kv: new Map() }); // shares the sign-in sessions in local dev
const MIN = 60000, DOORS = 10 * MIN, GRACE = 15 * MIN, KEEP = 7 * 86400000, MAX_AHEAD = 30 * 86400000, PER_WALLET = 3;
const MAPS = {
  bonfire: ['race', 'Bonfire Bay'], night: ['race', 'Night Rally'], halloween: ['race', 'Pumpkin Pass'], chain: ['race', 'Block Runner'], quantum: ['race', 'Quantum Loop'],
  pit: ['arena', 'The Pit'], degenz: ['arena', 'Degen Plaza'], stack: ['arena', 'Sky Stack'], maze: ['arena', 'Rug Maze'],
};

async function kv(...cmds) {
  if (!RURL) return cmds.map(([c, k, ...a]) => {
    const m = mem.kv;
    const exp = m.get('exp:' + k); if (exp && exp < Date.now()) { m.delete(k); m.delete('exp:' + k); } // EX / PX like Redis
    if (c === 'GET') return m.get(k) ?? null;
    if (c === 'DEL') { m.delete(k); return 1; }
    if (c === 'SET') { if (a.includes('NX') && m.has(k)) return null; m.set(k, a[0]); const i = a.findIndex(x => x === 'EX' || x === 'PX'); if (i > 0) m.set('exp:' + k, Date.now() + +a[i + 1] * (a[i] === 'EX' ? 1000 : 1)); else m.delete('exp:' + k); return 'OK'; }
    if (c === 'EXPIRE') return 1;
    if (c === 'ZADD') { const z = m.get(k) || new Map(); z.set(a[1], +a[0]); m.set(k, z); return 1; }
    if (c === 'ZRANGEBYSCORE') { const z = m.get(k) || new Map(); return [...z].filter(([, s]) => s >= +a[0]).sort((x, y) => x[1] - y[1]).map(([v]) => v); }
    if (c === 'ZREM') { m.get(k)?.delete(a[0]); return 1; }
    if (c === 'MGET') return [k, ...a].map(x => m.get(x) ?? null);
    return null;
  });
  const r = await fetch(RURL + '/pipeline', { method: 'POST', headers: { authorization: 'Bearer ' + RTOK, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('store ' + r.status);
  return (await r.json()).map(x => x.result);
}
function body(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise(res => { let s = ''; req.on('data', c => { s += c; if (s.length > 8000) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(s)); } catch { res({}); } }); });
}
function send(res, code, obj) { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(obj)); }
const clean = (v, max) => String(v ?? '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const int = (v, lo, hi, d) => { v = +v; return Number.isInteger(v) && v >= lo && v <= hi ? v : d; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const validId = id => /^[A-Z2-9]{6}$/.test(String(id || ''));
async function whoIs(req) {
  const tok = (String(req.headers.cookie || '').match(/(?:^|;\s*)pfs=([A-Za-z0-9]+)/) || [])[1];
  return tok ? (await kv(['GET', 'pf:sess:' + tok]))[0] : null;
}

async function fastestBelievable(e) {
  const board = (e.map === 'bonfire' ? 'race' : e.map) + e.laps;
  let wr = 0; try { const [z] = await kv(['ZRANGE', 'kart:' + board, '0', '0', 'WITHSCORES']); wr = +(z?.[1] || 0); } catch {}
  return Math.max(15 * e.laps, wr ? wr * 0.85 : 0);
}
function statusOf(e, now = Date.now()) {
  if (e.cancelled) return 'cancelled';
  if (e.results) return 'finished';
  if (now < e.at - DOORS) return 'scheduled';
  if (now <= e.at + GRACE) return 'open';
  return 'expired';
}
async function load(id) { const [raw] = await kv(['GET', 'ev:' + id]); return raw ? JSON.parse(raw) : null; }
const save = e => kv(['SET', 'ev:' + e.id, JSON.stringify(e), 'PX', String(Math.max(MIN, e.at + KEEP - Date.now()))]);
const REPORT_WAIT = 2 * MIN; // after this, players who never reported keep the host's record
const fmtTime = t => { const m = Math.floor(t / 60), x = t - m * 60; return `${m}:${x.toFixed(2).padStart(5, '0')}`; };
// final standings: own reports first, host record as fallback, impossible results disqualified, then re-sorted
function settle(e, now = Date.now()) {
  if (!e.results) return null;
  const rows = e.results.map(r => {
    const own = r.human ? e.reports?.[r.slot] : null, src = own || r;
    const finished = !!src.finished, time = +src.time || 0, kills = +src.kills || 0;
    const dq = e.mode === 'race' ? finished && time < (e.minTime || 15 * e.laps) : kills > 25 * e.mins;
    return { slot: r.slot, name: r.name, human: r.human, finished, time, kills, dq, own: !!own, hostPlace: r.place };
  });
  rows.sort((a, b) => (a.dq - b.dq) || (e.mode === 'race'
    ? (b.finished - a.finished) || (a.finished ? a.time - b.time : a.hostPlace - b.hostPlace)
    : (b.kills - a.kills) || (a.hostPlace - b.hostPlace)));
  const out = rows.map((r, i) => ({ place: i + 1, name: r.name, human: r.human, dq: r.dq, score: r.dq ? 'DQ' : e.mode === 'race' ? (r.finished ? fmtTime(r.time) : 'DNF') : `${r.kills} kills` }));
  const waiting = rows.some(r => r.human && !r.own) && now < (e.finishedAt || 0) + REPORT_WAIT;
  return { rows: out, state: waiting ? 'counting' : 'final' };
}
async function view(e) {
  const [room] = await kv(['GET', 'ev:room:' + e.id]);
  const { creator, ...pub } = e;
  const chk = settle(e); delete pub.reports; delete pub.minTime; delete pub.verdict;
  if (chk) pub.results = chk.rows;
  return { ...pub, resultState: chk?.state || null, by: creator ? creator.slice(0, 6) + '…' + creator.slice(-4) : '', mine: false, status: statusOf(e), doorsAt: e.at - DOORS, closesAt: e.at + GRACE, room: room ? JSON.parse(room) : null, link: `${SITE}/e/${e.id}` };
}

// ---------------- share card (PNG) ----------------
// fonts ship with the code (api/_fonts, Latin subsets of Anton and Archivo, open licence): no download per cold start
const FONTS = [['Anton', 400, 'anton-400'], ['Archivo', 500, 'archivo-500'], ['Archivo', 700, 'archivo-700']]
  .map(([name, weight, file]) => { try { return { name, weight, style: 'normal', data: require('fs').readFileSync(require('path').join(__dirname, '_fonts', file + '.woff')) }; } catch { return null; } }).filter(Boolean);
let wolfP; // the wolf picture, fetched once per warm server instance and kept in memory (≈60 KB)
const wolf = () => (wolfP ||= fetch(`${SITE}/racers/degenz.png`).then(r => r.ok ? r.arrayBuffer() : null).then(b => b && 'data:image/png;base64,' + Buffer.from(b).toString('base64')).catch(() => { wolfP = null; return null; }));
const h = (type, style, children) => ({ type, props: { style: { display: 'flex', ...style }, children } });
function when(e) {
  const d = new Date(e.at), f = (o, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...o }).format(d);
  let local = '', zone = e.tz;
  try { local = f({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }, e.tz); zone = f({ timeZoneName: 'short' }, e.tz).split(' ').pop(); } catch { zone = 'UTC'; local = f({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }, 'UTC'); }
  return { local: `${local} ${zone}`, utc: f({ hour: '2-digit', minute: '2-digit', hour12: false }, 'UTC') + ' UTC' };
}
async function card(e) {
  const { ImageResponse } = await import('@vercel/og'), wolfSrc = await wolf();
  const st = statusOf(e), [world, mapName] = MAPS[e.map] || ['race', e.map], t = when(e);
  const pill = (txt, bg, fg = '#150b05') => h('div', { background: bg, color: fg, borderRadius: 999, padding: '8px 22px', fontSize: 26, fontFamily: 'Archivo', fontWeight: 700 }, txt);
  const settled = settle(e), rs = settled?.state;
  const badge = st === 'finished' ? (rs === 'counting' ? ['RESULTS COMING IN', '#e9c46a'] : ['🏆 FINAL RESULTS', '#e9c46a'])
    : { scheduled: ['UPCOMING', '#ff7a1f'], open: ['DOORS OPEN · JOIN NOW', '#4fd27a'], expired: ['ENDED', '#8f8079'], cancelled: ['CANCELLED', '#ff4b4b'] }[st];
  const top3 = (settled?.rows || []).filter(r => !r.dq).slice(0, 3);
  const body = top3.length
    ? h('div', { flexDirection: 'column', gap: 10, marginTop: 26 }, top3.map((r, i) => h('div', { alignItems: 'center', gap: 18, fontSize: i ? 38 : 52, fontFamily: 'Archivo', fontWeight: 700, color: i ? '#ece4dc' : '#ffd23f' }, [`${['🥇', '🥈', '🥉'][i]}`, h('div', {}, r.name), h('div', { color: '#8f8079', fontSize: 28, fontWeight: 500 }, r.score || '')])))
    : h('div', { flexDirection: 'column', gap: 14, marginTop: 30 }, [
      h('div', { fontSize: 44, fontFamily: 'Archivo', fontWeight: 700, color: '#ece4dc' }, `🗓️ ${t.local}`),
      h('div', { fontSize: 30, fontFamily: 'Archivo', fontWeight: 500, color: '#8f8079' }, `${t.utc} · times shown in your own zone on the page`),
    ]);
  const el = h('div', { width: '100%', height: '100%', flexDirection: 'column', justifyContent: 'space-between', padding: '56px 64px', background: 'radial-gradient(circle at 78% 18%, #4a2312 0%, #160c0b 45%, #070506 100%)', color: '#ece4dc', fontFamily: 'Archivo' }, [
    ...(wolfSrc ? [{ type: 'img', props: { src: wolfSrc, width: 300, height: 300, style: { position: 'absolute', right: 56, top: 170, borderRadius: 150, border: '8px solid #ff7a1f' } } }] : []),
    h('div', { flexDirection: 'column' }, [
      h('div', { alignItems: 'center', gap: 16, fontSize: 28, fontWeight: 700, color: '#ff7a1f', letterSpacing: 3 }, [h('div', {}, '🏁 DEGENZ KART TOURNAMENT'), pill(badge[0], badge[1])]),
      h('div', { fontFamily: 'Anton', fontSize: e.title.length > 26 ? 76 : 96, lineHeight: 1.02, marginTop: 18, textTransform: 'uppercase', color: '#fff6e3', maxWidth: 740 }, e.title),
      body,
    ]),
    h('div', { alignItems: 'center', justifyContent: 'space-between' }, [
      h('div', { gap: 14 }, [pill(`👥 ${e.players} PLAYERS`, '#2b2022', '#ece4dc'), pill(`${world === 'race' ? '🏁' : '💥'} ${mapName.toUpperCase()}`, '#2b2022', '#ece4dc'), pill(world === 'race' ? `${e.laps} LAP${e.laps > 1 ? "S" : ""}` : `${e.mins} MIN`, '#2b2022', '#ece4dc')]),
      h('div', { fontSize: 26, color: '#8f8079', fontWeight: 500 }, 'starknetdegenz.fun'),
    ]),
  ]);
  const r = new ImageResponse(el, { width: 1200, height: 630, fonts: FONTS, emoji: 'twemoji' });
  return Buffer.from(await r.arrayBuffer());
}
// Cards are drawn on demand and never stored by us. Each look has its own URL (status + result state + reports),
// so Vercel's CDN can cache it for good and forgets it when nobody asks any more. Creating or cancelling a tournament
// requests the new URL once so the CDN already has it when the link gets shared (X gives up on slow images).
const cardVer = e => statusOf(e) + (e.results ? '-' + settle(e).state + '-' + Object.keys(e.reports || {}).length : '');
const warmCard = e => process.env.VERCEL ? fetch(`${SITE}/e/${e.id}/card-${cardVer(e)}.png`, { signal: AbortSignal.timeout(9000) }).then(r => r.arrayBuffer()).catch(() => {}) : Promise.resolve();
function sharePage(e) {
  const st = statusOf(e), t = when(e), [, mapName] = MAPS[e.map] || ['', e.map];
  const title = st === 'finished' ? `${e.title}: results` : `${e.title} · Degenz Kart tournament`;
  const desc = st === 'finished' ? `🥇 ${settle(e).rows.find(r => !r.dq)?.name || ''} won. ${e.players}-player ${mapName} race on Starknet Degenz.` : `${t.local} (${t.utc}) · ${e.players} players · ${mapName}. Join with the link: free, in your browser.`;
  const img = `${SITE}/e/${e.id}/card-${cardVer(e)}.png`, go = `/race?t=${e.id}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="$DEGENZ"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${img}"><meta property="og:image:type" content="image/png"><meta property="og:image:alt" content="${esc(title)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:url" content="${SITE}/e/${e.id}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@StarknetDegenz"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${img}">
<style>body{background:#070506;color:#ece4dc;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#ff7a1f}</style></head>
<body><p>Opening the tournament… <a href="${go}">tap here if nothing happens</a></p><script>location.replace(${JSON.stringify(go)})</script></body></html>`;
}

module.exports = async (req, res) => {
  try {
    if (!RURL && process.env.VERCEL) return send(res, 503, { error: 'store not configured' });
    const q = new URL(req.url, 'http://x').searchParams;
    if (req.method === 'GET') {
      if (q.get('card') || q.get('share')) {
        const id = String(q.get('card') || q.get('share')).toUpperCase(), e = validId(id) ? await load(id) : null;
        if (q.get('share')) {
          res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'public, max-age=60, s-maxage=60');
          if (!e) { res.statusCode = 404; return res.end('<!doctype html><meta http-equiv="refresh" content="0; url=/race"><p>That tournament is gone. <a href="/race">Play Degenz Kart</a></p>'); }
          // make sure the card sits in the CDN near this server before X (or anyone) asks for the image: a hit takes
          // ~0.1 s, a miss draws it once (~3 s) and caches it. Slow first images are what make X show no picture.
          await warmCard(e);
          return res.end(sharePage(e));
        }
        if (!e) return send(res, 404, { error: 'no such event' });
        const png = await card(e);
        res.statusCode = 200; res.setHeader('content-type', 'image/png'); res.setHeader('content-length', png.length);
        // a versioned URL (/e/<id>/card-<look>.png) never changes content: the CDN may keep it; the bare ?card= form only briefly
        res.setHeader('cache-control', q.get('f') ? 'public, max-age=86400, s-maxage=31536000, immutable' : 'public, max-age=60, s-maxage=300');
        return res.end(png);
      }
      if (q.get('id')) {
        const id = String(q.get('id')).toUpperCase(), e = validId(id) ? await load(id) : null;
        if (!e) return send(res, 404, { error: 'That tournament does not exist or has ended.' });
        const v = await view(e), who = await whoIs(req).catch(() => null);
        return send(res, 200, { ...v, mine: !!who && who === e.creator });
      }
      // list: everything not yet finished or expired, soonest first
      const ids = await kv(['ZRANGEBYSCORE', 'ev:list', String(Date.now() - GRACE), '+inf']);
      const raws = (ids[0] || []).length ? (await kv(['MGET', ...ids[0].slice(0, 60).map(i => 'ev:' + i)]))[0] : [];
      const events = [];
      for (const raw of raws || []) { if (!raw) continue; const e = JSON.parse(raw), st = statusOf(e); if (st === 'scheduled' || st === 'open') events.push(await view(e)); }
      return send(res, 200, { events: events.slice(0, 30) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const b = await body(req), now = Date.now();

    if (b.create) {
      const who = await whoIs(req); if (!who) return send(res, 401, { error: 'Sign in on the site first (wallet icon at the top of any page).' });
      const c = b.create, at = Math.round(+c.at / MIN) * MIN;
      if (!Number.isFinite(at) || at < now + 5 * MIN || at > now + MAX_AHEAD) return send(res, 400, { error: 'Pick a start time between 5 minutes and 30 days from now.' });
      const title = clean(c.title, 40); if (title.length < 3) return send(res, 400, { error: 'Give it a name (3 to 40 characters).' });
      const map = MAPS[c.map] ? c.map : 'bonfire';
      let tz = clean(c.tz, 40); try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { tz = 'UTC'; }
      // at most 3 upcoming events per wallet
      const ids = (await kv(['ZRANGEBYSCORE', 'ev:list', String(now), '+inf']))[0] || [];
      const mine = ids.length ? ((await kv(['MGET', ...ids.map(i => 'ev:' + i)]))[0] || []).filter(Boolean).map(x => JSON.parse(x)).filter(e => e.creator === who && !e.cancelled) : [];
      if (mine.length >= PER_WALLET) return send(res, 429, { error: `You already have ${PER_WALLET} upcoming tournaments. Cancel one or wait for it to finish.` });
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const id = Array.from(crypto.randomBytes(6), x => alphabet[x % alphabet.length]).join('');
      const e = { id, title, creator: who, at, tz, players: int(c.players, 2, 12, 4), map, mode: MAPS[map][0], laps: int(c.laps, 1, 9, 3), mins: int(c.mins, 1, 10, 3), created: now };
      await save(e); await kv(['ZADD', 'ev:list', String(at), id]);
      await warmCard(e); // the CDN has the card before anyone shares the link
      return send(res, 200, { ...(await view(e)), mine: true });
    }

    const id = String(b.cancel || b.room || b.results || b.report || '').toUpperCase();
    if (!validId(id)) return send(res, 400, { error: 'bad event' });
    const e = await load(id); if (!e) return send(res, 404, { error: 'That tournament does not exist or has ended.' });
    const st = statusOf(e);

    if (b.cancel) {
      const who = await whoIs(req); if (!who || who !== e.creator) return send(res, 403, { error: 'Only the creator can cancel it.' });
      if (st !== 'scheduled') return send(res, 409, { error: 'It can only be cancelled before doors open.' });
      e.cancelled = now; await save(e); await kv(['ZREM', 'ev:list', id]); await warmCard(e);
      return send(res, 200, await view(e));
    }
    if (b.room) {
      // first host to report a room wins; everyone else is told to join that one
      if (st !== 'open') return send(res, 409, { error: 'not open', status: st });
      const code = String(b.code || '').toUpperCase();
      if (!/^[A-Z0-9]{5}$/.test(code)) return send(res, 400, { error: 'bad code' });
      if (b.leave) { const [cur] = await kv(['GET', 'ev:room:' + id]); if (cur && JSON.parse(cur).code === code) await kv(['DEL', 'ev:room:' + id]); return send(res, 200, { ok: true }); }
      const mine = JSON.stringify({ code, players: int(b.players, 1, 12, 1), at: now });
      const [ok] = await kv(['SET', 'ev:room:' + id, mine, 'NX', 'EX', '20']);
      if (ok) return send(res, 200, { room: JSON.parse(mine) });
      const [cur] = await kv(['GET', 'ev:room:' + id]), live = cur ? JSON.parse(cur) : null;
      if (!live || live.code === code) { await kv(['SET', 'ev:room:' + id, mine, 'EX', '20']); return send(res, 200, { room: JSON.parse(mine) }); }
      return send(res, 200, { room: live });
    }
    if (b.results) {
      if (e.results) return send(res, 200, await view(e)); // first report wins
      if (st !== 'open' || now < e.at - DOORS) return send(res, 409, { error: 'not open' });
      const [cur] = await kv(['GET', 'ev:room:' + id]);
      if (cur && JSON.parse(cur).code !== String(b.code || '').toUpperCase()) return send(res, 403, { error: 'not the event room' });
      const min = e.mode === 'race' ? await fastestBelievable(e) : 0;
      const order = (Array.isArray(b.order) ? b.order : []).slice(0, 12).map((r, i) => {
        const finished = !!r?.finished, time = Math.round(+r?.time * 100) / 100 || 0, kills = int(r?.kills, 0, 999, 0);
        return { place: i + 1, slot: int(r?.slot, 0, 11, i), name: clean(r?.name, 14).toUpperCase() || 'PLAYER', human: !!r?.human, finished, time, kills };
      });
      e.minTime = min;
      if (order.filter(r => r.human).length < 2) return send(res, 400, { error: 'needs at least 2 players' });
      e.results = order; e.finishedAt = now; e.resultsCode = String(b.code || '').toUpperCase();
      for (const [k, r] of Object.entries(e.reports || {})) if (r.code !== e.resultsCode) delete e.reports[k]; // reports from another room don't count
      await save(e); await kv(['ZREM', 'ev:list', id]);
      return send(res, 200, await view(e));
    }
    if (b.report) {
      // each player's own result; the first one per seat counts, and only from the event's room
      if (!e.results && st !== 'open') return send(res, 409, { error: 'not open' });
      if (e.finishedAt && now > e.finishedAt + 10 * MIN) return send(res, 409, { error: 'too late' });
      const slot = int(b.slot, 0, 11, -1); if (slot < 0) return send(res, 400, { error: 'bad seat' });
      e.reports ||= {};
      if (e.resultsCode && String(b.code || '').toUpperCase() !== e.resultsCode) return send(res, 403, { error: 'not the event room' });
      if (!e.reports[slot]) { e.reports[slot] = { code: String(b.code || '').toUpperCase().slice(0, 5), finished: !!b.finished, time: Math.round(+b.time * 100) / 100 || 0, kills: int(b.kills, 0, 999, 0), at: now }; await save(e); }
      return send(res, 200, { ok: true });
    }
    send(res, 400, { error: 'unknown request' });
  } catch (err) {
    send(res, 500, { error: 'Tournaments are unavailable right now.' });
  }
};

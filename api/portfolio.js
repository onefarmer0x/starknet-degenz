// Starknet wallet portfolio: every token the wallet holds (from AVNU's ~3000-token list), with logos, USD prices
// and the main pool for each, plus NFTs when a Voyager API key is configured.
//   GET /api/portfolio?address=0x...   -> { address, totalUsd, tokens: [...], nfts: [...] | null, nftNote }
//   GET /api/portfolio?info=0x<token>  -> { twitter, telegram, website, discord, description } (socials, cached a day)
// Balances are read straight from chain (batched balanceOf calls); prices / pools come from GeckoTerminal, with
// AVNU's market data as a fallback. Optional env: VOYAGER_API_KEY (NFTs), STARKNET_RPC (one URL or a comma
// separated list tried in order; defaults to Cartridge's free public endpoint).
// Built for many visitors: prices/pools (5 min) and whole scans (60 s) are shared through Redis, and each visitor
// can start at most SCAN_LIMIT fresh scans a minute.
const RPCS = (process.env.STARKNET_RPC || 'https://api.cartridge.gg/x/starknet/mainnet').split(',').map(s => s.trim()).filter(Boolean);
const SCAN_LIMIT = 10;
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const VOYAGER = process.env.VOYAGER_API_KEY;
const SEL = { balanceOf: '0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e', balance_of: '0x35a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33' };
const mem = globalThis.__pf || (globalThis.__pf = { tokens: null, tokensAt: 0, market: null, marketAt: 0, gecko: {}, result: {} });

const norm = a => '0x' + BigInt(a).toString(16).padStart(64, '0');
async function redis(...cmds) {
  if (!RURL) return cmds.map(() => null);
  const r = await fetch(RURL + '/pipeline', { method: 'POST', headers: { authorization: 'Bearer ' + RTOK, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  return r.ok ? (await r.json()).map(x => x.result) : cmds.map(() => null);
}
// one retry on 429 (GeckoTerminal's free tier is ~30 calls/min)
const getJson = async (url, opts, retry = 1) => { const r = await fetch(url, opts); if (r.status === 429 && retry) { await new Promise(s => setTimeout(s, 1500)); return getJson(url, opts, retry - 1); } if (!r.ok) throw new Error(url.split('?')[0] + ' ' + r.status); return r.json(); };

// ---------- token list: AVNU (all tokens they know, verified or not), cached a day ----------
async function tokenList() {
  if (mem.tokens && Date.now() - mem.tokensAt < 6 * 3600e3) return mem.tokens;
  const [cached] = await redis(['GET', 'pf:tokens']).catch(() => [null]);
  if (cached) { mem.tokens = JSON.parse(cached); mem.tokensAt = Date.now(); return mem.tokens; }
  const first = await getJson('https://starknet.api.avnu.fi/v1/starknet/tokens?page=0&size=200');
  const pages = await Promise.all(Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, i) => getJson(`https://starknet.api.avnu.fi/v1/starknet/tokens?page=${i + 1}&size=200`).catch(() => ({ content: [] }))));
  const seen = new Set(), list = [];
  for (const t of [first, ...pages].flatMap(p => p.content || [])) {
    const a = norm(t.address); if (seen.has(a)) continue; seen.add(a);
    list.push({ a, s: t.symbol, n: t.name, d: t.decimals, l: t.logoUri || '', v: (t.tags || []).includes('Verified') ? 1 : 0 });
  }
  mem.tokens = list; mem.tokensAt = Date.now();
  await redis(['SET', 'pf:tokens', JSON.stringify(list), 'EX', 86400]).catch(() => {});
  return list;
}

// ---------- balances: batched starknet_call, balanceOf then balance_of for the ones that errored ----------
async function rpcBatch(calls) {
  const body = calls.map((c, id) => ({ jsonrpc: '2.0', id, method: 'starknet_call', params: { request: { contract_address: c.a, entry_point_selector: c.sel, calldata: [c.who] }, block_id: 'latest' } }));
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await r.json(); if (!Array.isArray(out)) throw new Error('rpc batch');
      const byId = new Map(out.map(x => [x.id, x])); return calls.map((_, i) => byId.get(i));
    } catch {}
  }
  throw new Error('rpc unavailable');
}
async function balances(who, tokens) {
  const res = new Map(), CH = 250;
  const run = async (list, sel) => {
    const failed = [];
    const chunks = []; for (let i = 0; i < list.length; i += CH) chunks.push(list.slice(i, i + CH));
    for (let i = 0; i < chunks.length; i += 4) {
      await Promise.all(chunks.slice(i, i + 4).map(async ch => {
        let rows; try { rows = await rpcBatch(ch.map(t => ({ a: t.a, sel, who }))); } catch { failed.push(...ch); return; }
        rows.forEach((x, j) => {
          if (!x || x.error || !x.result) { failed.push(ch[j]); return; }
          const v = BigInt(x.result[0] || 0) + (BigInt(x.result[1] || 0) << 128n);
          if (v > 0n) res.set(ch[j].a, v);
        });
      }));
    }
    return failed;
  };
  const failed = await run(tokens, SEL.balanceOf);
  if (failed.length > tokens.length * 0.5) throw new Error('Starknet RPC is busy'); // most batches failed: don't show a half-empty wallet
  if (failed.length) await run(failed, SEL.balance_of);
  return res;
}

// ---------- prices + pools ----------
async function avnuMarket() {
  if (mem.market && Date.now() - mem.marketAt < 300e3) return mem.market;
  const m = new Map();
  try { for (const t of await getJson('https://starknet.impulse.avnu.fi/v1/tokens')) if (t.market?.currentPrice) m.set(norm(t.address), t.market.currentPrice); } catch {}
  mem.market = m; mem.marketAt = Date.now(); return m;
}
async function gecko(addrs) {
  const out = {}; let delayed = false;
  let need = addrs.filter(a => { const c = mem.gecko[a]; if (c && Date.now() - c.at < 120e3) { out[a] = c; return false; } return true; });
  if (need.length && RURL) { // shared across all server instances / visitors
    const [vals] = await redis(['MGET', ...need.map(a => 'pf:gk:' + a)]).catch(() => [[]]);
    need = need.filter((a, i) => { const v = vals?.[i]; if (!v) return true; out[a] = mem.gecko[a] = JSON.parse(v); return false; });
  }
  const fresh = [];
  for (let i = 0; i < need.length; i += 30) {
    const ch = need.slice(i, i + 30);
    try {
      const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/starknet-alpha/tokens/multi/${ch.join(',')}?include=top_pools`, { headers: { accept: 'application/json' } });
      const pools = new Map((j.included || []).filter(x => x.type === 'pool').map(p => [p.id, p.attributes]));
      for (const t of j.data || []) {
        const a = norm(t.attributes.address), top = (t.relationships?.top_pools?.data || [])[0], p = top && pools.get(top.id);
        fresh.push(a); out[a] = mem.gecko[a] = {
          at: Date.now(), price: t.attributes.price_usd ? +t.attributes.price_usd : null, img: t.attributes.image_url && !/missing/.test(t.attributes.image_url) ? t.attributes.image_url : '',
          pool: p ? { name: p.name, address: p.address, liq: +p.reserve_in_usd || 0, url: `https://www.geckoterminal.com/starknet-alpha/pools/${p.address}`, change24: p.price_change_percentage?.h24 != null ? +p.price_change_percentage.h24 : null } : null,
        };
      }
      for (const a of ch) if (!out[a]) { fresh.push(a); out[a] = mem.gecko[a] = { at: Date.now(), price: null, img: '', pool: null }; }
    } catch { delayed = true; } // rate limited: those tokens fall back to AVNU prices this time
  }
  if (fresh.length && RURL) await redis(...fresh.map(a => ['SET', 'pf:gk:' + a, JSON.stringify(out[a]), 'EX', 300])).catch(() => {});
  return { map: out, delayed };
}

// ---------- NFTs (Voyager indexer; needs VOYAGER_API_KEY) ----------
async function nfts(who) {
  if (!VOYAGER) return { list: null, note: 'NFTs need a Voyager API key (VOYAGER_API_KEY) on the server.' };
  const H = { headers: { 'x-api-key': VOYAGER, accept: 'application/json' } };
  for (const base of ['https://api.voyager.online/beta', 'https://public-api.voyager.online/beta']) {
    try {
      const j = await getJson(`${base}/nft-contract-balance?owner_address=${who}&limit=100`, H);
      const items = j.items || j.data || [];
      const list = items.slice(0, 100).map(x => ({
        contract: x.contractAddress || x.contract_address || x.address || '',
        name: x.name || x.contractName || x.collectionName || 'NFT',
        count: +(x.balance ?? x.count ?? x.tokenCount ?? 1),
        image: x.image || x.imageUrl || x.image_url || x.logo || x.collectionImage || '',
        tokenId: x.tokenId ?? x.token_id ?? null,
      }));
      return { list, note: '' };
    } catch {}
  }
  return { list: [], note: 'NFT indexer did not answer, try again later.' };
}

// ---------- token socials (GeckoTerminal token info), fetched when someone opens a token, cached a day ----------
async function tokenInfo(a) {
  const c = mem.info?.[a]; if (c && Date.now() - c.at < 86400e3) return c.d;
  const [cached] = await redis(['GET', 'pf:info:' + a]).catch(() => [null]);
  if (cached) { (mem.info ||= {})[a] = { at: Date.now(), d: JSON.parse(cached) }; return mem.info[a].d; }
  const t = (await getJson(`https://api.geckoterminal.com/api/v2/networks/starknet-alpha/tokens/${a}/info`, { headers: { accept: 'application/json' } })).data?.attributes || {};
  const d = { twitter: t.twitter_handle || '', telegram: t.telegram_handle || '', website: (t.websites || [])[0] || '', discord: t.discord_url || '', description: String(t.description || '').length > 280 ? String(t.description).slice(0, 277).trimEnd() + '…' : String(t.description || '') };
  (mem.info ||= {})[a] = { at: Date.now(), d };
  await redis(['SET', 'pf:info:' + a, JSON.stringify(d), 'EX', 86400]).catch(() => {});
  return d;
}

function send(res, code, obj) { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(obj)); }

module.exports = async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams, raw = (q.get('address') || '').trim();
  if (q.get('info')) {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(q.get('info'))) return send(res, 400, { error: 'bad token' });
    try { return send(res, 200, await tokenInfo(norm(q.get('info')))); } catch { return send(res, 503, { error: 'busy' }); }
  }
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(raw)) return send(res, 400, { error: 'Enter a Starknet address (0x…)' });
  const who = norm(raw);
  const hit = mem.result[who]; if (hit && Date.now() - hit.at < 45e3 && !q.get('fresh')) return send(res, 200, hit.data);
  try {
    if (!q.get('fresh')) { const [c] = await redis(['GET', 'pf:res:' + who]).catch(() => [null]); if (c) { const data = JSON.parse(c); mem.result[who] = { at: data.at, data }; return send(res, 200, data); } }
    // fresh scans are the expensive part (~3,000 RPC calls): cap them per visitor
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'anon';
    const [n] = await redis(['INCR', `pf:rl:${ip}:${Math.floor(Date.now() / 60e3)}`], ['EXPIRE', `pf:rl:${ip}:${Math.floor(Date.now() / 60e3)}`, 90]).catch(() => [0]);
    if (n > SCAN_LIMIT) return send(res, 429, { error: 'Too many scans in a minute, wait a moment and try again.' });
    const [list, market, nf] = await Promise.all([tokenList(), avnuMarket(), nfts(who)]);
    const bal = await balances(who, list);
    const held = list.filter(t => bal.has(t.a));
    // GeckoTerminal allows ~30 calls/min: look up at most 90 tokens (verified first), the rest fall back to AVNU prices
    const { map: gk, delayed } = await gecko([...held].sort((x, y) => y.v - x.v).slice(0, 90).map(t => t.a));
    const tokens = held.map(t => {
      const amount = Number(bal.get(t.a)) / 10 ** t.d, g = gk[t.a] || {}, price = g.price ?? market.get(t.a) ?? null;
      return { address: t.a, symbol: t.s, name: t.n, decimals: t.d, logo: t.l || g.img || '', verified: !!t.v, balance: amount, raw: bal.get(t.a).toString(), price, value: price != null ? amount * price : null, pool: g.pool || null, counted: price != null && (!!t.v || (g.pool?.liq || 0) >= 1000) };
    }).sort((a, b) => b.counted - a.counted || (b.value || 0) - (a.value || 0) || b.verified - a.verified);
    // totalUsd only counts verified tokens or ones with a real pool (spam guard)
    const data = { address: who, at: Date.now(), totalUsd: tokens.reduce((s, t) => s + (t.counted ? t.value : 0), 0), tokens, scanned: list.length, nfts: nf.list, nftNote: nf.note, pricesDelayed: delayed };
    mem.result[who] = { at: Date.now(), data };
    if (!delayed) await redis(['SET', 'pf:res:' + who, JSON.stringify(data), 'EX', 60]).catch(() => {}); // don't share a scan with missing prices
    send(res, 200, data);
  } catch (e) {
    send(res, 502, { error: 'Could not read the wallet right now (' + e.message + ')' });
  }
};

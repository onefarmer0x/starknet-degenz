// Daily rewards, XP, levels and badges for signed-in wallets (used by api/pfauth.js, which owns the session).
// Everything is decided here on the server: one claim per address per UTC day, streaks, XP, and badges checked
// against on-chain data ($DEGENZ held, $DEGENZ burned). Kart stats are reported by the game and only unlock cosmetics.
// Stored under rw:<address> as one JSON record. (Files starting with _ are not deployed as their own endpoint.)
const RPCS = (process.env.STARKNET_RPC || 'https://api.cartridge.gg/x/starknet/mainnet').split(',').map(s => s.trim()).filter(Boolean);
const TOKEN = '0x049092ff7929ee84fec51b8f1658cea5083d6c83dbc18d7b106d8c7d2389b100';
const DEPLOY_BLOCK = 16480353;
const SEL = {
  transfer: '0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9',
  balance_of: '0x35a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33',
  balanceOf: '0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e',
  total_supply: '0x1557182e4359a1f0c6301278e8f5b35a776ab58d39892581e357578fb287836',
  totalSupply: '0x80aa9fdbfaf9615e4afc7f5f722e265daca5ccc655360fa5ccacf9c267936d',
};
const DAY_MS = 86400000, CHAIN_TTL = 10 * 60 * 1000;

// ---- badge NFTs (contracts/degenz_badges): earned badges can be minted as ERC-721 tokens ----
// BADGE_CONTRACT = the deployed contract, BADGE_NETWORK = mainnet | sepolia, BADGE_SIGNER_KEY = the site's signing key
// (made with tools/badge-signer.js). The key can only say "this wallet earned this badge"; it holds no funds.
const NFT_NET = { mainnet: { chainId: '0x534e5f4d41494e', rpc: 'https://api.cartridge.gg/x/starknet/mainnet' }, sepolia: { chainId: '0x534e5f5345504f4c4941', rpc: 'https://api.cartridge.gg/x/starknet/sepolia' } };
const nftCfg = () => {
  const net = NFT_NET[process.env.BADGE_NETWORK || 'mainnet'], contract = process.env.BADGE_CONTRACT, key = process.env.BADGE_SIGNER_KEY;
  return net && /^0x[0-9a-fA-F]{1,64}$/.test(contract || '') && /^0x[0-9a-fA-F]{1,64}$/.test(key || '') ? { ...net, network: process.env.BADGE_NETWORK || 'mainnet', contract, key } : null;
};
const hx = x => '0x' + BigInt(x).toString(16);
const shortStr = s => hx('0x' + Buffer.from(s, 'ascii').toString('hex'));
// the same hash lib.cairo computes: pedersen over (tag, chain id, contract, badge, wallet), left to right
function voucherHash(chainId, contract, badge, wallet) {
  const { hash } = require('starknet'), H = (a, b) => hx(hash.computePedersenHash(a, b));
  return H(H(H(H(shortStr('degenz.badge'), chainId), contract), shortStr(badge)), wallet);
}
const today = () => Math.floor(Date.now() / DAY_MS);
const weekOf = d => Math.floor((d + 3) / 7); // Monday-based weeks (day 0 was a Thursday)

// ---- levels: level L needs 60·(L-1)² XP in total ----
const xpFor = L => 60 * (L - 1) ** 2;
const levelOf = xp => { let L = 1; while (xp >= xpFor(L + 1)) L++; return L; };
// XP per claim grows with the streak (capped), plus a bonus on milestone days
const claimXp = s => 20 + 5 * Math.min(s - 1, 10);
const MILESTONE = { 3: 30, 7: 100, 14: 150, 30: 500, 60: 800, 100: 2000, 365: 10000 };

// ---- badges ----
// cat: how you earn it (daily / hold / burn / race / portfolio). rarity: common / silver / gold / trophy.
// test(ctx) with ctx = { rec, chain, state }
const tok = v => Number(BigInt(v || 0) / 10n ** 15n) / 1000; // token amount (18 decimals) as a number
const supplyPct = (c, p) => tok(c.chain?.supply || 0) * p;
const PROGRESS = {
  howl: c => [c.rec.claims, 1, 'claims'], streak7: c => [c.rec.best, 7, 'days'], streak30: c => [c.rec.best, 30, 'days'], streak100: c => [c.rec.best, 100, 'days'],
  lv10: c => [levelOf(c.rec.xp), 10, 'level'], lv25: c => [levelOf(c.rec.xp), 25, 'level'],
  pup: c => c.chain && [tok(c.chain.bal), 1, '$DEGENZ'], wolf: c => c.chain && [tok(c.chain.bal), supplyPct(c, 0.001), '$DEGENZ'],
  alpha: c => c.chain && [tok(c.chain.bal), supplyPct(c, 0.005), '$DEGENZ'], leader: c => c.chain && [tok(c.chain.bal), supplyPct(c, 0.01), '$DEGENZ'],
  kindling: c => c.chain && [tok(c.chain.burned), 1, 'burned'], feeder: c => c.chain && [tok(c.chain.burned), 1e6, 'burned'], inferno: c => c.chain && [tok(c.chain.burned), 1e7, 'burned'],
  win: c => [c.rec.kart?.wins || 0, 1, 'wins'], combo: c => [c.rec.kart?.combo || 0, 10, '× combo'], kart10: c => [c.rec.kart?.level || 0, 10, 'kart level'], kart20: c => [c.rec.kart?.level || 0, 20, 'kart level'],
  watcher: c => c.state && [c.state.wallets?.length || 0, 3, 'wallets'], bundler: c => c.state && [c.state.bundles?.length || 0, 1, 'bundles'],
};
const TRAIL = { howl: '🔸 Ember', streak7: '🔥 Wildfire', streak30: '🌈 Rainbow', wolf: '🐺 Gold Wolf', leader: '👑 Royal', kindling: '🪵 Ashes', combo: '⚡ Neon' };
const BADGES = [
  { id: 'howl', cat: 'daily', icon: '👋', name: 'First Howl', rarity: 'common', desc: 'Claim your first daily reward', test: c => c.rec.claims >= 1 },
  { id: 'streak7', cat: 'daily', icon: '🔥', name: 'Week Wolf', rarity: 'silver', desc: 'Reach a 7-day streak', test: c => c.rec.best >= 7 },
  { id: 'streak30', cat: 'daily', icon: '🌋', name: 'Iron Howl', rarity: 'gold', desc: 'Reach a 30-day streak', test: c => c.rec.best >= 30 },
  { id: 'streak100', cat: 'daily', icon: '☀️', name: 'Eternal Flame', rarity: 'trophy', desc: 'Reach a 100-day streak', test: c => c.rec.best >= 100 },
  { id: 'lv10', cat: 'daily', icon: '⭐', name: 'Rising Star', rarity: 'silver', desc: 'Reach account level 10', test: c => levelOf(c.rec.xp) >= 10 },
  { id: 'lv25', cat: 'daily', icon: '🌟', name: 'Legend', rarity: 'trophy', desc: 'Reach account level 25', test: c => levelOf(c.rec.xp) >= 25 },
  { id: 'pup', cat: 'hold', icon: '🐶', name: 'Pup', rarity: 'common', desc: 'Hold any $DEGENZ', test: c => c.chain && c.chain.bal > 0n },
  { id: 'wolf', cat: 'hold', icon: '🐺', name: 'Wolf', rarity: 'silver', desc: 'Hold 1M $DEGENZ (0.1% of supply)', test: c => c.chain && c.chain.supply > 0n && c.chain.bal * 1000n >= c.chain.supply },
  { id: 'alpha', cat: 'hold', icon: '🦴', name: 'Alpha', rarity: 'gold', desc: 'Hold 5M $DEGENZ (0.5% of supply)', test: c => c.chain && c.chain.supply > 0n && c.chain.bal * 200n >= c.chain.supply },
  { id: 'leader', cat: 'hold', icon: '👑', name: 'Pack Leader', rarity: 'trophy', desc: 'Hold 10M $DEGENZ (1% of supply)', test: c => c.chain && c.chain.supply > 0n && c.chain.bal * 100n >= c.chain.supply },
  { id: 'kindling', cat: 'burn', icon: '🪵', name: 'Kindling', rarity: 'common', desc: 'Burn $DEGENZ on the bonfire', test: c => c.chain && c.chain.burned > 0n },
  { id: 'feeder', cat: 'burn', icon: '🔥', name: 'Fire Feeder', rarity: 'silver', desc: 'Burn 1M $DEGENZ in total', test: c => c.chain && c.chain.burned >= 10n ** 24n },
  { id: 'inferno', cat: 'burn', icon: '☄️', name: 'Inferno', rarity: 'gold', desc: 'Burn 10M $DEGENZ in total', test: c => c.chain && c.chain.burned >= 10n ** 25n },
  { id: 'win', cat: 'race', icon: '🏁', name: 'First Win', rarity: 'common', desc: 'Win a Degenz Kart race or arena', test: c => (c.rec.kart?.wins || 0) >= 1 },
  { id: 'combo', cat: 'race', icon: '⚡', name: 'Combo King', rarity: 'silver', desc: 'Hit a 10× combo in Degenz Kart', test: c => (c.rec.kart?.combo || 0) >= 10 },
  { id: 'kart10', cat: 'race', icon: '🏎️', name: 'Pro Driver', rarity: 'silver', desc: 'Reach kart level 10', test: c => (c.rec.kart?.level || 0) >= 10 },
  { id: 'kart20', cat: 'race', icon: '🏆', name: 'Max Level', rarity: 'gold', desc: 'Reach kart level 20', test: c => (c.rec.kart?.level || 0) >= 20 },
  { id: 'watcher', cat: 'portfolio', icon: '💼', name: 'Watcher', rarity: 'common', desc: 'Track 3 wallets in your portfolio', test: c => (c.state?.wallets?.length || 0) >= 3 },
  { id: 'bundler', cat: 'portfolio', icon: '📦', name: 'Bundler', rarity: 'common', desc: 'Make a portfolio bundle', test: c => (c.state?.bundles?.length || 0) >= 1 },
];

// ---- on-chain checks (raw JSON-RPC, tried against each configured node) ----
async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error('rpc');
}
const u256 = a => BigInt(a[0] || 0) + (BigInt(a[1] || 0) << 128n);
async function call(sels, calldata) {
  for (const s of sels) { try { return u256(await rpc('starknet_call', { request: { contract_address: TOKEN, entry_point_selector: s, calldata }, block_id: 'latest' })); } catch {} }
  return 0n;
}
async function burnedBy(addr) {
  let sum = 0n, token, pages = 0;
  do {
    const r = await rpc('starknet_getEvents', { filter: { from_block: { block_number: DEPLOY_BLOCK }, to_block: 'latest', address: TOKEN, keys: [[SEL.transfer], [addr], ['0xdead']], chunk_size: 1000, ...(token ? { continuation_token: token } : {}) } });
    for (const e of r.events) if (e.keys.length >= 3 && BigInt(e.keys[1]) === BigInt(addr) && BigInt(e.keys[2]) === 0xdeadn) sum += u256(e.data);
    token = r.continuation_token;
  } while (token && ++pages < 20);
  return sum;
}
async function chainFacts(addr, rec) {
  const c = rec.chain;
  if (c && Date.now() - c.at < CHAIN_TTL) return { bal: BigInt(c.bal), supply: BigInt(c.supply), burned: BigInt(c.burned) };
  try {
    const [bal, supply, burned] = await Promise.all([call([SEL.balance_of, SEL.balanceOf], [addr]), call([SEL.total_supply, SEL.totalSupply], []), burnedBy(addr)]);
    rec.chain = { at: Date.now(), bal: String(bal), supply: String(supply), burned: String(burned) };
    return { bal, supply, burned };
  } catch { return c ? { bal: BigInt(c.bal), supply: BigInt(c.supply), burned: BigInt(c.burned) } : null; } // RPC down: last known
}

const blank = () => ({ xp: 0, streak: 0, best: 0, last: -1, claims: 0, freezeWeek: -1, badges: {}, kart: null });
async function load(kv, addr) { const [raw] = await kv(['GET', 'rw:' + addr]); return raw ? { ...blank(), ...JSON.parse(raw) } : blank(); }
const save = (kv, addr, rec) => kv(['SET', 'rw:' + addr, JSON.stringify(rec)]);

// award any badges now earned (badges are permanent once earned)
async function refreshBadges(addr, rec, state, withChain = true) {
  const chain = withChain ? await chainFacts(addr, rec) : null, fresh = [];
  for (const b of BADGES) if (!rec.badges[b.id] && b.test({ rec, chain, state })) { rec.badges[b.id] = Date.now(); fresh.push(b.id); }
  return fresh;
}
// streak still alive? (claimed today or yesterday, or the weekly freeze covers one missed day)
function liveStreak(rec, d = today()) {
  if (rec.last >= d - 1) return rec.streak;
  if (rec.last === d - 2 && rec.freezeWeek !== weekOf(d)) return rec.streak;
  return 0;
}
function view(addr, rec, state) {
  const d = today(), L = levelOf(rec.xp), s = liveStreak(rec, d);
  return {
    address: addr, xp: rec.xp, level: L, levelXp: xpFor(L), nextXp: xpFor(L + 1), streak: s, best: rec.best, claims: rec.claims,
    canClaim: rec.last < d, nextClaimAt: (d + 1) * DAY_MS, freezeLeft: rec.freezeWeek !== weekOf(d), nft: nftInfo(),
    nextGain: rec.last < d ? claimXp((rec.last >= d - 1 || (rec.last === d - 2 && rec.freezeWeek !== weekOf(d)) ? rec.streak : 0) + 1) : 0,
    badges: BADGES.map(({ test, ...b }) => {
      let p = null; try { p = PROGRESS[b.id]?.({ rec, chain: rec.chain, state }) || null; } catch {}
      return { ...b, img: '/badges/' + b.id + '.webp', at: rec.badges[b.id] || null, progress: p && [Math.round(p[0] * 100) / 100, Math.round(p[1]), p[2]], trail: TRAIL[b.id] || null }; // medallions made from the Telegram wolf stickers
    }),
  };
}

async function claim(kv, addr, state) {
  const d = today(), [lock] = await kv(['SET', `rw:c:${addr}:${d}`, '1', 'NX', 'EX', 90000]); // stops two clicks at once claiming twice
  const rec = await load(kv, addr);
  if (rec.last >= d || !lock) return { error: 'Already claimed today. Come back tomorrow!', view: view(addr, rec, state) };
  let froze = false;
  if (rec.last === d - 1) rec.streak++;
  else if (rec.last === d - 2 && rec.freezeWeek !== weekOf(d)) { rec.streak++; rec.freezeWeek = weekOf(d); froze = true; }
  else rec.streak = 1;
  const before = levelOf(rec.xp), bonus = MILESTONE[rec.streak] || 0, gained = claimXp(rec.streak) + bonus;
  rec.xp += gained; rec.last = d; rec.claims++; rec.best = Math.max(rec.best, rec.streak);
  const fresh = await refreshBadges(addr, rec, state);
  await save(kv, addr, rec);
  return { gained, bonus, froze, levelUp: levelOf(rec.xp) > before, fresh, view: view(addr, rec, state) };
}
async function me(kv, addr, state) {
  const rec = await load(kv, addr), fresh = await refreshBadges(addr, rec, state);
  if (fresh.length || rec.chain) await save(kv, addr, rec);
  return { fresh, view: view(addr, rec, state) };
}
// kart stats from the game (self-reported, so they only ever unlock cosmetic badges); numbers only go up
async function kart(kv, addr, k, state) {
  const rec = await load(kv, addr), o = rec.kart || {};
  const n = (v, max) => Math.max(0, Math.min(max, Math.floor(+v || 0)));
  rec.kart = { level: Math.max(o.level || 0, n(k?.level, 20)), wins: Math.max(o.wins || 0, n(k?.wins, 100000)), combo: Math.max(o.combo || 0, n(k?.combo, 99)) };
  const fresh = await refreshBadges(addr, rec, state, false);
  await save(kv, addr, rec);
  return { fresh, view: view(addr, rec, state) };
}
async function profile(kv, addr) { return view(addr, await load(kv, addr)); }
// a mint voucher for a badge this wallet has earned (null if NFTs aren't set up or the badge isn't earned)
async function voucher(kv, addr, id) {
  const c = nftCfg(); if (!c) return { error: 'Badge NFTs are not live yet.' };
  const b = BADGES.find(x => x.id === id); if (!b) return { error: 'Unknown badge.' };
  const rec = await load(kv, addr); if (!rec.badges[id]) return { error: 'Earn this badge first.' };
  const { ec } = require('starknet'), sig = ec.starkCurve.sign(voucherHash(c.chainId, c.contract, id, addr), c.key);
  return { contract: c.contract, network: c.network, badge: shortStr(id), r: hx(sig.r), s: hx(sig.s) };
}
const nftInfo = () => { const c = nftCfg(); return c ? { contract: c.contract, network: c.network, rpc: c.rpc } : null; };

module.exports = { claim, me, kart, profile, voucher, nftInfo, voucherHash, shortStr, BADGES };

// Portfolio sign-in with a Starknet wallet. The wallet signs a short SNIP-12 message (free, no transaction); we ask
// the account contract on-chain whether the signature is valid, then keep a 30-day session cookie. The saved list
// (wallets, names, bundles) lives under the wallet address, so the same wallet sees it on every device.
//   GET  /api/pfauth?nonce=1            -> { nonce, typedData }        message for the wallet to sign
//   POST /api/pfauth { address, signature, nonce } -> { address, state }  sign in (sets the session cookie)
//   GET  /api/pfauth                    -> { address, state } | 401     who am I
//   POST /api/pfauth { save: state }    -> { ok }                       save my list (needs the session)
//   POST /api/pfauth { logout: true }   -> { ok }
const crypto = require('crypto');
const { typedData: TD, RpcProvider, num } = require('starknet');
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const RPCS = (process.env.STARKNET_RPC || 'https://api.cartridge.gg/x/starknet/mainnet').split(',').map(s => s.trim()).filter(Boolean);
const mem = globalThis.__pfauth || (globalThis.__pfauth = { kv: new Map() }); // local dev without Redis
const DAY = 86400, SESSION_DAYS = 30;

async function kv(...cmds) {
  if (!RURL) return cmds.map(([c, k, v]) => { if (c === 'GET') return mem.kv.get(k) ?? null; if (c === 'SET') { mem.kv.set(k, v); return 'OK'; } if (c === 'GETDEL') { const x = mem.kv.get(k) ?? null; mem.kv.delete(k); return x; } if (c === 'DEL') { mem.kv.delete(k); return 1; } return null; });
  const r = await fetch(RURL + '/pipeline', { method: 'POST', headers: { authorization: 'Bearer ' + RTOK, 'content-type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('store ' + r.status);
  return (await r.json()).map(x => x.result);
}
function body(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise(res => { let s = ''; req.on('data', c => { s += c; if (s.length > 40000) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(s)); } catch { res({}); } }); });
}
function send(res, code, obj, cookie) {
  res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
  if (cookie !== undefined) res.setHeader('set-cookie', cookie);
  res.end(JSON.stringify(obj));
}
const norm = a => '0x' + BigInt(a).toString(16).padStart(64, '0');
const cookieOf = req => (String(req.headers.cookie || '').match(/(?:^|;\s*)pfs=([A-Za-z0-9]+)/) || [])[1];
const sessionCookie = tok => `pfs=${tok}; Path=/api/pfauth; HttpOnly; SameSite=Lax; Max-Age=${tok ? SESSION_DAYS * DAY : 0}${process.env.VERCEL ? '; Secure' : ''}`;

// same shape the page saves; anything else is dropped
const ADDR = /^0x[0-9a-f]{64}$/;
function clean(s) {
  const wallets = (Array.isArray(s?.wallets) ? s.wallets : []).filter(w => ADDR.test(w?.a)).slice(0, 100).map(w => ({ a: w.a, label: String(w.label || '').slice(0, 20) }));
  const known = new Set(wallets.map(w => w.a));
  const bundles = (Array.isArray(s?.bundles) ? s.bundles : []).slice(0, 30).map(b => ({ id: String(b.id || '').replace(/[^\w-]/g, '').slice(0, 16), name: String(b.name || 'Bundle').slice(0, 24), wallets: (Array.isArray(b.wallets) ? b.wallets : []).filter(a => known.has(a)) })).filter(b => b.id);
  return { wallets, bundles };
}

const loginMessage = (nonce, issued) => ({
  types: {
    StarknetDomain: [{ name: 'name', type: 'shortstring' }, { name: 'version', type: 'shortstring' }, { name: 'chainId', type: 'shortstring' }, { name: 'revision', type: 'shortstring' }],
    Login: [{ name: 'action', type: 'shortstring' }, { name: 'site', type: 'shortstring' }, { name: 'nonce', type: 'felt' }, { name: 'issued', type: 'felt' }],
  },
  primaryType: 'Login',
  domain: { name: 'Degenz Portfolio', version: '1', chainId: 'SN_MAIN', revision: '1' },
  message: { action: 'Sign in (free, no transaction)', site: 'starknetdegenz.fun', nonce, issued: String(issued) },
});

// ask the account contract itself (works for Argent / Ready, Braavos and any other Starknet account)
async function validSignature(address, hash, sig) {
  const calldata = [hash, String(sig.length), ...sig.map(x => num.toHex(x))];
  for (const url of RPCS) {
    const p = new RpcProvider({ nodeUrl: url });
    for (const entrypoint of ['is_valid_signature', 'isValidSignature']) {
      try {
        const r = await p.callContract({ contractAddress: address, entrypoint, calldata }, 'latest');
        const v = BigInt(r[0] ?? 0);
        return v === 0x56414c4944n || v === 1n; // 'VALID' (SNIP-6) or 1 (older accounts)
      } catch (e) {
        if (/not deployed|not found|Contract not found/i.test(e.message || '')) throw new Error('This account is not deployed yet. Make one transaction with it first, then sign in.');
        // invalid signatures often revert inside the account: treat as "not valid" once both entrypoints were tried
      }
    }
    return false;
  }
  return false;
}

module.exports = async (req, res) => {
  try {
    if (!RURL && process.env.VERCEL) return send(res, 503, { error: 'store not configured' });
    const q = new URL(req.url, 'http://x').searchParams;
    if (req.method === 'GET' && q.get('nonce')) {
      const nonce = '0x' + crypto.randomBytes(24).toString('hex'), issued = Math.floor(Date.now() / 1000);
      await kv(['SET', 'pf:nonce:' + nonce, String(issued), 'EX', 300]);
      return send(res, 200, { nonce, typedData: loginMessage(nonce, issued) });
    }
    const tok = cookieOf(req);
    const who = tok ? (await kv(['GET', 'pf:sess:' + tok]))[0] : null;
    if (req.method === 'GET') {
      if (!who) return send(res, 401, { error: 'not signed in' });
      const [raw] = await kv(['GET', 'pf:user:' + who]);
      return send(res, 200, { address: who, state: raw ? JSON.parse(raw) : null });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const b = await body(req);
    if (b.logout) { if (tok) await kv(['DEL', 'pf:sess:' + tok]); return send(res, 200, { ok: true }, sessionCookie('')); }
    if (b.save) {
      if (!who) return send(res, 401, { error: 'not signed in' });
      await kv(['SET', 'pf:user:' + who, JSON.stringify(clean(b.save))]);
      return send(res, 200, { ok: true });
    }
    // sign in
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(String(b.address || '')) || !Array.isArray(b.signature) || !b.signature.length || b.signature.length > 40) return send(res, 400, { error: 'bad sign-in request' });
    const [issued] = await kv(['GETDEL', 'pf:nonce:' + String(b.nonce || '')]); // one use only
    if (!issued) return send(res, 400, { error: 'Sign-in message expired, try again.' });
    const address = norm(b.address);
    const hash = TD.getMessageHash(loginMessage(String(b.nonce), issued), address);
    let ok;
    try { ok = await validSignature(address, hash, b.signature.map(String)); } catch (e) { return send(res, 400, { error: e.message }); }
    if (!ok) return send(res, 401, { error: 'The signature did not check out for this wallet.' });
    const session = crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '');
    const [, raw] = await kv(['SET', 'pf:sess:' + session, address, 'EX', SESSION_DAYS * DAY], ['GET', 'pf:user:' + address]);
    send(res, 200, { address, state: raw ? JSON.parse(raw) : null }, sessionCookie(session));
  } catch (e) {
    send(res, 500, { error: 'Sign-in is unavailable right now.' });
  }
};

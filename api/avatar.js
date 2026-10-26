// Vercel function: fetch a token avatar from an allowed image host and serve it with CORS,
// so the game can paint it onto a WebGL texture. GET /api/avatar?url=<image url>
const ALLOWED = ['cdn.dexscreener.com', 'assets.geckoterminal.com', 'coin-images.coingecko.com', 'assets.coingecko.com'];

async function fetchAvatar(raw) {
  let u;
  try { u = new URL(raw); } catch { return { status: 400, error: 'Bad url' }; }
  if (u.protocol !== 'https:' || !ALLOWED.includes(u.hostname)) return { status: 403, error: 'Host not allowed' };
  const r = await fetch(u, { headers: { accept: 'image/png,image/webp,image/jpeg,image/*' }, redirect: 'follow' });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) return { status: 502, error: 'Not an image' };
  const body = Buffer.from(await r.arrayBuffer());
  if (body.length > 3 * 1024 * 1024) return { status: 413, error: 'Image too large' };
  return { status: 200, type, body };
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x').searchParams.get('url') || '';
  const out = await fetchAvatar(url).catch(() => ({ status: 502, error: 'Fetch failed' }));
  res.setHeader('access-control-allow-origin', '*');
  if (out.status !== 200) { res.statusCode = out.status; return res.end(out.error); }
  res.setHeader('content-type', out.type);
  res.setHeader('cache-control', 'public, max-age=86400, s-maxage=604800');
  res.end(out.body);
};
module.exports.fetchAvatar = fetchAvatar;

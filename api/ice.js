// ICE servers for kart rooms (WebRTC). STUN finds a direct path; TURN relays traffic when phones / strict
// networks can't connect directly (otherwise joiners hang on "Connecting…").
// Configure one of these in Vercel → Settings → Environment Variables:
//   Cloudflare TURN (free tier): CF_TURN_KEY_ID + CF_TURN_API_TOKEN  → short-lived credentials generated per request
//   Any other TURN service:      TURN_URLS (comma separated) + TURN_USERNAME + TURN_CREDENTIAL
const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] };

async function cloudflare() {
  const id = process.env.CF_TURN_KEY_ID, token = process.env.CF_TURN_API_TOKEN;
  if (!id || !token) return null;
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d.iceServers ? [].concat(d.iceServers) : null;
}
function staticTurn() {
  const { TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
  if (!TURN_URLS || !TURN_USERNAME || !TURN_CREDENTIAL) return null;
  return [{ urls: TURN_URLS.split(',').map(s => s.trim()).filter(Boolean), username: TURN_USERNAME, credential: TURN_CREDENTIAL }];
}

module.exports = async (req, res) => {
  let turn = null;
  try { turn = (await cloudflare()) || staticTurn(); } catch { turn = staticTurn(); }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ iceServers: [STUN, ...(turn || [])], relay: !!turn }));
};

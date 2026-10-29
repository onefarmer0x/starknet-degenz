// Metadata for Starknet Degenz Badges tokens (contracts/degenz_badges). The contract's token_uri is
// <base_uri><token id>, with base_uri = https://www.starknetdegenz.fun/api/nft/ (vercel.json routes /api/nft/<id> here).
// We ask the contract which badge the token is, then answer with its name, picture and traits.
//   GET /api/nft?id=42  ->  { name, description, image, external_url, attributes }
const RW = require('./_rewards.js');
const SITE = (process.env.SITE_URL || 'https://www.starknetdegenz.fun').replace(/\/+$/, '');
const GROUP = { daily: 'Daily activity', hold: 'Holding $DEGENZ', burn: 'Burning', race: 'Racing', portfolio: 'Portfolio' };
const RARITY = { common: 'Common', silver: 'Silver', gold: 'Gold', trophy: 'Trophy' };
const SELECTOR = '0x' + require('starknet').hash.getSelectorFromName('badge_of').replace(/^0x/, '');

function send(res, code, body, age) {
  res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', code === 200 ? `public, max-age=300, s-maxage=${age}` : 'no-store'); // a token's badge never changes
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
  if (!/^\d{1,12}$/.test(id) || id === '0') return send(res, 400, { error: 'bad token id' });
  const c = RW.nftInfo(); if (!c) return send(res, 404, { error: 'not live yet' });
  try {
    const r = await fetch(c.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'starknet_call', params: { request: { contract_address: c.contract, entry_point_selector: SELECTOR, calldata: ['0x' + BigInt(id).toString(16), '0x0'] }, block_id: 'latest' } }) });
    const j = await r.json(), felt = BigInt(j.result?.[0] || 0);
    if (!felt) return send(res, 404, { error: 'no such token' });
    const slug = Buffer.from(felt.toString(16).padStart(2, '0'), 'hex').toString('ascii'), b = RW.BADGES.find(x => x.id === slug);
    if (!b) return send(res, 404, { error: 'unknown badge' });
    send(res, 200, {
      name: `${b.name} #${id}`,
      description: `${b.desc}. A Starknet Degenz profile badge, earned on starknetdegenz.fun and minted by its holder.`,
      image: `${SITE}/badges/nft/${b.id}.png`,
      external_url: `${SITE}/profile#${b.id}`,
      attributes: [{ trait_type: 'Badge', value: b.name }, { trait_type: 'Rarity', value: RARITY[b.rarity] }, { trait_type: 'Group', value: GROUP[b.cat] || 'Daily activity' }],
    }, 86400);
  } catch { send(res, 502, { error: 'chain unavailable, try again' }); }
};

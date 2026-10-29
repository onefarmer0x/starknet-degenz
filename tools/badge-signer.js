// Makes the key the site signs badge-mint vouchers with, and shows the public half, which the contract
// (contracts/degenz_badges) needs when it is deployed, or in set_signer to replace a key.
//
//   node tools/badge-signer.js         make one if .env has none, then show the public key
//   node tools/badge-signer.js --new   replace the one in .env (then call set_signer on the contract)
//
// The private key is written to .env as BADGE_SIGNER_KEY and never printed. Copy it into the Vercel project's
// environment variables yourself. It holds no funds and cannot mint anything itself: it can only say that a
// wallet earned a badge.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ec } = require('starknet');

const ENV = path.join(__dirname, '..', '.env');
let text = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
let key = (/^BADGE_SIGNER_KEY=(0x[0-9a-fA-F]+)\s*$/m.exec(text) || [])[1];
const fresh = process.argv.includes('--new') || !key;
if (fresh) {
  key = '0x' + Buffer.from(ec.starkCurve.utils.randomPrivateKey(crypto.randomBytes(48))).toString('hex');
  text = text.replace(/^BADGE_SIGNER_KEY=.*\r?\n?/m, '');
  fs.writeFileSync(ENV, text + (text && !text.endsWith('\n') ? '\n' : '') + `BADGE_SIGNER_KEY=${key}\n`);
  console.log('A new signing key was written to .env (BADGE_SIGNER_KEY). Add the same value in Vercel: Settings → Environment Variables.');
}
console.log('Public key (give this to the contract):');
console.log('  0x' + BigInt(ec.starkCurve.getStarkKey(key)).toString(16));
if (fresh && process.argv.includes('--new')) console.log('The contract still trusts the old key: send set_signer(<public key above>) from the owner wallet.');

// Deploys the Starknet Degenz Badges contract (contracts/degenz_badges) from this machine.
//
//   node tools/badge-deploy.js --network sepolia --owner 0x...          show what would happen
//   node tools/badge-deploy.js --network sepolia --owner 0x... --yes    do it
//   node tools/badge-deploy.js --network mainnet --owner 0x... --yes
//
// Before running:
//   1. Build the contract:      scarb build   (inside contracts/degenz_badges)
//   2. Make the signing key:    node tools/badge-signer.js
//   3. Put a deployer in .env. It only pays the fee and has no power over the contract:
//        BADGE_DEPLOYER_ADDRESS=0x...   a Starknet account on that network, holding a little STRK
//        BADGE_DEPLOYER_KEY=0x...       its private key
//      Use a fresh account made for this, not your main wallet. Remove both lines afterwards.
//
// --owner is the wallet that will own the contract: the only one that can replace the signing key or move the
// metadata URL. Use the wallet you keep safe. It does not need to be the deployer.
//
// Nothing secret is printed. At the end it prints the three values to put in Vercel's environment variables.
const fs = require('fs');
const path = require('path');
const { RpcProvider, Account, CallData, hash, ec } = require('starknet');

const ROOT = path.join(__dirname, '..');
const arg = name => { const i = process.argv.indexOf('--' + name); return i === -1 ? '' : process.argv[i + 1] || ''; };
const fail = msg => { console.error(msg); process.exit(1); };
const hex = x => '0x' + BigInt(x).toString(16);
const env = {};
if (fs.existsSync(path.join(ROOT, '.env'))) for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2]; }

const network = arg('network');
const NET = {
  sepolia: { rpc: 'https://api.cartridge.gg/x/starknet/sepolia', chainId: '0x534e5f5345504f4c4941', explorer: 'https://sepolia.voyager.online/contract/' },
  mainnet: { rpc: 'https://api.cartridge.gg/x/starknet/mainnet', chainId: '0x534e5f4d41494e', explorer: 'https://voyager.online/contract/' },
}[network];
if (!NET) fail('Say which network: --network sepolia   or   --network mainnet');
const isAddress = x => /^0x[0-9a-fA-F]{1,64}$/.test(x) && BigInt(x) > 0n && BigInt(x) < 2n ** 251n;
const owner = arg('owner');
if (!isAddress(owner)) fail('Say who will own the contract: --owner 0x...   (your own safe wallet)');
if (!/^0x[0-9a-fA-F]{1,64}$/.test(env.BADGE_SIGNER_KEY || '')) fail('No signing key yet. Run: node tools/badge-signer.js');
if (!isAddress(env.BADGE_DEPLOYER_ADDRESS || '') || !/^0x[0-9a-fA-F]{1,64}$/.test(env.BADGE_DEPLOYER_KEY || '')) fail('No deployer in .env. Add BADGE_DEPLOYER_ADDRESS and BADGE_DEPLOYER_KEY (see the top of this file).');

const dir = path.join(ROOT, 'contracts', 'degenz_badges', 'target', 'dev');
const read = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { fail(`Build the contract first: scarb build (inside contracts/degenz_badges). Missing ${f}`); } };
const sierra = read('degenz_badges_DegenzBadges.contract_class.json');
const casm = read('degenz_badges_DegenzBadges.compiled_contract_class.json');
const classHash = hash.computeContractClassHash(sierra);
const baseUri = (arg('site') || 'https://www.starknetdegenz.fun').replace(/\/+$/, '') + '/api/nft/';
const signer = hex(ec.starkCurve.getStarkKey(env.BADGE_SIGNER_KEY));
const calldata = new CallData(sierra.abi).compile('constructor', { owner, signer, base_uri: baseUri });

(async () => {
  const provider = new RpcProvider({ nodeUrl: NET.rpc });
  const chain = hex(await provider.getChainId());
  if (BigInt(chain) !== BigInt(NET.chainId)) fail(`That node is not ${network}: it answers for chain ${chain}`);
  console.log(`Network:        ${network}`);
  console.log(`Deployer:       ${env.BADGE_DEPLOYER_ADDRESS}`);
  console.log(`Owner:          ${owner}`);
  console.log(`Signing key:    ${signer}   (public half)`);
  console.log(`Token metadata: ${baseUri}<token id>`);
  console.log(`Class hash:     ${classHash}`);
  try { await provider.getClassHashAt(env.BADGE_DEPLOYER_ADDRESS); } catch { fail(`\nThe deployer account does not exist on ${network} yet. Create it in a wallet on that network and make one transaction from it.`); }
  const account = new Account(provider, env.BADGE_DEPLOYER_ADDRESS, env.BADGE_DEPLOYER_KEY);
  if (!process.argv.includes('--yes')) { console.log('\nNothing was sent. Add --yes to deploy.'); return; }

  console.log('\nDeclaring the contract code…');
  const declared = await account.declareIfNot({ contract: sierra, casm });
  if (declared.transaction_hash) { await provider.waitForTransaction(declared.transaction_hash); console.log(`  declared in ${declared.transaction_hash}`); }
  else console.log('  already declared on this network');
  console.log('Deploying…');
  const deployed = await account.deployContract({ classHash, constructorCalldata: calldata });
  await provider.waitForTransaction(deployed.transaction_hash);
  const address = hex(deployed.contract_address);
  console.log(`  deployed in ${deployed.transaction_hash}`);

  // read it back: is the contract set up the way it was asked to be?
  const call = async entry => hex((await provider.callContract({ contractAddress: address, entrypoint: entry, calldata: [] }))[0]);
  const ok = BigInt(await call('signer')) === BigInt(signer) && BigInt(await call('owner')) === BigInt(owner);
  console.log(ok ? '  checked: the contract trusts the signing key and is owned by the owner' : '  WARNING: the contract does not report the signer or owner that was asked for');
  console.log(`\nContract: ${address}\n          ${NET.explorer}${address}`);
  console.log('\nPut these in Vercel (Settings → Environment Variables), then redeploy the site:');
  console.log(`  BADGE_CONTRACT=${address}`);
  console.log(`  BADGE_NETWORK=${network}`);
  console.log('  BADGE_SIGNER_KEY=<the value from .env>');
  console.log('\nYou can now remove BADGE_DEPLOYER_ADDRESS and BADGE_DEPLOYER_KEY from .env.');
})().catch(e => {
  const text = String(e.message || e), base = e.baseError ? JSON.stringify(e.baseError).slice(0, 1500) : '';
  fail('\nFailed: ' + (base || (text.length > 1500 ? '… ' + text.slice(-1500) : text)));
});

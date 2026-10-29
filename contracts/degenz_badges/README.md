# Starknet Degenz Badges (DGZB)

The profile badges from starknetdegenz.fun as ERC-721 tokens on Starknet (`src/lib.cairo`, OpenZeppelin 2.0.0).

- One token per mint. Token ids count up from 1; `badge_of(id)` says which badge it is (e.g. `'wolf'`).
- A wallet can mint each badge it has earned once, from its own wallet, paying only the network fee.
- Tokens are ordinary ERC-721s: they can be transferred and sold.
- `token_uri(id)` = `https://www.starknetdegenz.fun/api/nft/<id>`, which answers with the name, picture
  (`/badges/nft/<badge>.png`, 512×512) and traits (Badge, Rarity, Group).

**It compiles (Scarb 2.11.4) but has not run on a network yet.** Deploy on Sepolia and mint there first.

## How minting is allowed

When a signed-in wallet presses **Mint as NFT** in the badge viewer, the site checks that wallet earned the
badge and signs a voucher over (tag, chain, contract, badge, wallet) with `BADGE_SIGNER_KEY`. The wallet sends
it to `claim(badge, r, s)`; the contract checks it against the public key it holds and mints.

The signing key holds no funds and can only say "this wallet earned this badge". If it were ever leaked,
someone could mint badges they didn't earn until you replace it: `node tools/badge-signer.js --new`, then call
`set_signer(<new public key>)` from the owner wallet.

## Deploy (Sepolia first)

```
cd contracts/degenz_badges && scarb build && cd ../..
node tools/badge-signer.js                                   # writes BADGE_SIGNER_KEY to .env, prints the public key
# add BADGE_DEPLOYER_ADDRESS and BADGE_DEPLOYER_KEY to .env (a throwaway account with a little STRK)
node tools/badge-deploy.js --network sepolia --owner 0xYOUR_WALLET          # dry run
node tools/badge-deploy.js --network sepolia --owner 0xYOUR_WALLET --yes
```

Then in Vercel → Settings → Environment Variables set `BADGE_CONTRACT`, `BADGE_NETWORK` (`sepolia` or
`mainnet`) and `BADGE_SIGNER_KEY`, and redeploy the site. The Mint button appears in the badge viewer once
`BADGE_CONTRACT` is set.

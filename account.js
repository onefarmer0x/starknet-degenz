// Account menu in the top bar (every page with .topnav): a wallet button next to BUY that opens a small dropdown.
// Signed out: the button opens the sign-in dialog (free signature, see api/pfauth.js). Signed in: the dropdown shows
// the address (copy / open in explorer) plus Portfolio and Settings; signing out lives in Settings. Pages can listen for the 'degenz:auth' event or use window.DegenzAccount.
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = a => a.slice(0, 6) + '…' + a.slice(-4);
  let me = null, state = null, readyResolve;
  const ready = new Promise(r => { readyResolve = r; });
  const emit = () => window.dispatchEvent(new CustomEvent('degenz:auth', { detail: { address: me, state } }));
  // a colour per wallet, so the button shows "which wallet" at a glance
  const hue = a => parseInt(a.slice(-6), 16) % 360;
  // simple line icons (drawn here, no icon font needed)
  const ICON = {
    wallet: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M5 4h12a2 2 0 0 1 2 2v1h-2V6H5a1 1 0 0 0 0 2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Zm11 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 3h9a2 2 0 0 1 2 2v11h-2V5H8V3Zm-3 4h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm0 2v10h9V9H5Z"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="m9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6L21 7.4 19.6 6z"/></svg>',
    ext: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3ZM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>',
  };

  const css = `
.topnav .acct { position: relative; margin-left: auto; }
.topnav .acct + .buy, html .topnav .acct + .buy { margin-left: 0; }
.acct-btn { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--d-line, #2b2022); background: var(--d-panel, #100c0d); color: var(--d-text, #ece4dc); font: 700 13px var(--d-body, Arial, sans-serif); cursor: pointer; white-space: nowrap; }
.acct-btn:hover, .acct-btn[aria-expanded="true"] { border-color: var(--d-ember, #ff7a1f); }
.acct-btn .ic { display: grid; place-items: center; }
.acct-btn .dot { width: 18px; height: 18px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px rgba(255,255,255,.08); }
.acct-btn small { font: 500 12px "DM Mono", monospace; color: var(--d-dim, #8f8079); }
.acct-menu { position: absolute; right: 0; top: calc(100% + 8px); min-width: 230px; background: var(--d-panel, #100c0d); border: 1px solid var(--d-line, #2b2022); border-radius: 12px; padding: 6px; box-shadow: 0 18px 40px rgba(0,0,0,.6); z-index: 80; }
.acct-menu[hidden] { display: none; }
.acct-menu .hd { padding: 10px 12px 8px; border-bottom: 1px solid var(--d-line, #2b2022); margin-bottom: 4px; font-size: 12px; color: var(--d-dim, #8f8079); }
.acct-menu .hd { display: flex; align-items: center; gap: 6px; }
.acct-menu .hd b { flex: 1; color: var(--d-text, #ece4dc); font: 500 13px "DM Mono", monospace; }
.acct-menu .hd .ib { width: 30px; height: 30px; padding: 0; justify-content: center; border-radius: 8px; color: var(--d-dim, #8f8079); flex: none; }
.acct-menu .hd .ib:hover { color: var(--d-text, #ece4dc); }
.acct-menu a, .acct-menu button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px; background: none; color: var(--d-text, #ece4dc); font: 500 14px var(--d-body, Arial, sans-serif); text-decoration: none; cursor: pointer; text-align: left; box-sizing: border-box; }
.acct-menu a:hover, .acct-menu button:hover { background: rgba(255,255,255,.05); }
.acct-menu .sep { height: 1px; background: var(--d-line, #2b2022); margin: 4px 0; }
.acct-menu .out { color: #ff6b6b; }
.acct-menu .cta { background: var(--d-ember, #ff7a1f); color: #150b05; font-weight: 700; justify-content: center; }
.acct-menu .cta:hover { background: var(--d-ember, #ff7a1f); filter: brightness(1.08); }
.acct-dlg { background: var(--d-panel, #100c0d); color: var(--d-text, #ece4dc); border: 1px solid var(--d-line, #2b2022); border-radius: 14px; padding: 20px; width: min(400px, calc(100vw - 32px)); font-family: var(--d-body, Arial, sans-serif); }
.acct-dlg::backdrop { background: rgba(0,0,0,.6); }
.acct-dlg h3 { margin: 0 0 6px; font: 400 26px var(--d-display, Impact, sans-serif); text-transform: uppercase; }
.acct-dlg p { color: var(--d-dim, #8f8079); font-size: 14px; margin: 0 0 12px; }
.acct-dlg .wl { display: grid; gap: 8px; }
.acct-dlg .wl button { display: flex; align-items: center; gap: 12px; width: 100%; background: var(--d-panel-2, #181213); border: 1px solid var(--d-line, #2b2022); border-radius: 12px; padding: 12px 14px; color: var(--d-text, #ece4dc); font: 700 15px var(--d-body, Arial, sans-serif); cursor: pointer; text-align: left; }
.acct-dlg .wl button:hover { border-color: var(--d-ember, #ff7a1f); }
.acct-dlg .wl button:disabled { opacity: .6; cursor: wait; }
.acct-dlg .wl img, .acct-dlg .wl .wi { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-size: 18px; flex: none; }
.acct-dlg .wl small { display: block; color: var(--d-dim, #8f8079); font-weight: 500; font-size: 12px; }
.acct-dlg .err { color: #ff6b6b; font-size: 14px; min-height: 1em; margin: 10px 0 0; }
.acct-dlg .row { display: flex; justify-content: flex-end; margin-top: 12px; }
.acct-dlg .row button { background: none; border: 1px solid var(--d-line, #2b2022); color: var(--d-text, #ece4dc); border-radius: 10px; padding: 9px 16px; font: 700 14px var(--d-body, Arial, sans-serif); cursor: pointer; }
@media (max-width: 640px) {
  .acct-btn { padding: 0 9px; height: 34px; }
  .acct-btn .lbl, .acct-btn small { display: none; } /* icon / colour dot only on phones */
  .acct-menu { position: fixed; left: 12px; right: 12px; top: 64px; min-width: 0; }
}`;

  // ---------- wallet detection (same set as the bonfire page) ----------
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const found = new Map();
  function scanWallets() {
    const names = new Set(['starknet', 'starknet_argentX', 'starknet_braavos', 'starknet_bramble', ...Object.getOwnPropertyNames(window).filter(k => k.startsWith('starknet'))]);
    for (const k of names) { let w; try { w = window[k]; } catch { continue; } if (!w || typeof w !== 'object' || (!w.request && !w.enable)) continue; const id = String(w.id || k.replace(/^starknet_?/, '') || 'starknet').toLowerCase(); if (!found.has(id)) found.set(id, { id, name: w.name || id, icon: w.icon, kind: 'injected', obj: w }); }
  }
  const addStd = w => { if (!Object.keys(w?.features || {}).some(f => f.startsWith('starknet:'))) return; const id = String(w.name).toLowerCase(); if (!found.has(id)) found.set(id, { id, name: w.name, icon: w.icon, kind: 'standard', obj: w }); };
  window.addEventListener('wallet-standard:register-wallet', e => { try { e.detail({ register: (...ws) => ws.forEach(addStd) }); } catch {} });
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: (...ws) => ws.forEach(addStd) } })); } catch {}
  [0, 800, 2500].forEach(ms => setTimeout(scanWallets, ms));

  async function connect(w, dlg) { // -> { addr, request }
    if (w.kind === 'standard') {
      const r = await w.obj.features['standard:connect'].connect(), api = w.obj.features['starknet:walletApi'] || Object.values(w.obj.features).find(x => typeof x?.request === 'function');
      return { addr: (r.accounts || w.obj.accounts)[0]?.address, request: c => api.request(c) };
    }
    if (w.kind === 'ready-mobile') {
      const mod = await import('/vendor/ready-mobile.js');
      const kit = mod.ArgentMobileConnector.init({ options: { dappName: 'Starknet Degenz', url: location.hostname, chainId: 'SN_MAIN', description: 'Starknet Degenz', icons: [], rpcUrl: 'https://api.cartridge.gg/x/starknet/mainnet' } });
      dlg.close(); const d = await kit.connect();
      return { addr: d.account, request: c => kit.request(c) };
    }
    const o = w.obj;
    if (o.request) { const a = await o.request({ type: 'wallet_requestAccounts' }); return { addr: a?.[0], request: c => o.request(c) }; }
    const a = await o.enable(); return { addr: a?.[0] || o.selectedAddress, request: c => o.request(c) };
  }

  // ---------- UI ----------
  let btn, menu, dlg;
  function build() {
    const nav = document.querySelector('.topnav'); if (!nav || nav.querySelector('.acct')) return false;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const box = document.createElement('div'); box.className = 'acct';
    box.innerHTML = '<button class="acct-btn" type="button" aria-haspopup="menu" aria-expanded="false"></button><div class="acct-menu" role="menu" hidden></div>';
    nav.insertBefore(box, nav.querySelector('.buy'));
    btn = box.querySelector('.acct-btn'); menu = box.querySelector('.acct-menu');
    dlg = document.createElement('dialog'); dlg.className = 'acct-dlg';
    dlg.innerHTML = '<h3>Sign in</h3><p>Pick your wallet. It will ask you to sign a message: free, no transaction, nothing leaves your wallet.</p><div class="wl"></div><p class="err" role="alert"></p><div class="row"><button type="button">Close</button></div>';
    document.body.appendChild(dlg); dlg.querySelector('.row button').onclick = () => dlg.close();
    btn.addEventListener('click', e => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('.acct')) toggle(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { toggle(false); btn.focus(); } });
    return true;
  }
  function toggle(open = menu.hidden) {
    if (!me) { menu.hidden = true; if (open) openWallets(); return; } // signed out: straight to the sign-in dialog
    menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
  }
  function render() {
    if (!btn) return;
    btn.innerHTML = me
      ? `<span class="dot" style="background:linear-gradient(135deg,hsl(${hue(me)} 80% 60%),hsl(${(hue(me) + 60) % 360} 80% 45%))"></span><small>${short(me)}</small>`
      : `<span class="ic">${ICON.wallet}</span><span class="lbl">Sign in</span>`;
    btn.setAttribute('aria-label', me ? `Account ${short(me)}` : 'Sign in with your wallet');
    btn.setAttribute('aria-haspopup', me ? 'menu' : 'dialog');
    if (!me) { menu.innerHTML = ''; return; }
    menu.innerHTML = `<div class="hd"><b>${short(me)}</b><button class="ib" type="button" data-act="copy" title="Copy address" aria-label="Copy address">${ICON.copy}</button><a class="ib" href="https://voyager.online/contract/${me}" target="_blank" rel="noopener" title="Open in Voyager" aria-label="Open in Voyager">${ICON.ext}</a></div>
      <a role="menuitem" href="/portfolio">💼 Portfolio</a>
      <a role="menuitem" href="/portfolio#settings">⚙️ Settings</a>`;
    menu.querySelector('[data-act="copy"]').addEventListener('click', e => { const b = e.currentTarget; navigator.clipboard?.writeText(me); b.innerHTML = ICON.check; setTimeout(() => { b.innerHTML = ICON.copy; }, 1200); });
  }

  function openWallets() {
    scanWallets();
    const list = [...found.values()];
    if (isMobile && !list.length) list.push({ name: 'Ready (Argent) mobile', kind: 'ready-mobile', blurb: 'Connect over WalletConnect' }, { name: 'Braavos app', kind: 'braavos-app', blurb: 'Opens this page in Braavos' });
    const wl = dlg.querySelector('.wl');
    wl.innerHTML = list.length ? list.map((w, i) => `<button type="button" data-w="${i}">${w.icon ? `<img src="${esc(typeof w.icon === 'string' ? w.icon : w.icon.dark || '')}" alt="">` : '<span class="wi">👛</span>'}<span>${esc(w.name)}<small>${esc(w.blurb || 'Browser wallet')}</small></span></button>`).join('')
      : '<p>No Starknet wallet found in this browser. Install <a href="https://www.ready.co/" target="_blank" rel="noopener" style="color:var(--d-ember,#ff7a1f)">Ready (Argent)</a> or <a href="https://braavos.app/" target="_blank" rel="noopener" style="color:var(--d-ember,#ff7a1f)">Braavos</a>.</p>';
    wl.querySelectorAll('[data-w]').forEach(b => b.addEventListener('click', () => { const w = list[+b.dataset.w]; if (w.kind === 'braavos-app') location.href = `https://link.braavos.app/dapp/${location.host}${location.pathname}`; else signIn(w, b); }));
    dlg.querySelector('.err').textContent = ''; if (!dlg.open) dlg.showModal();
  }
  async function signIn(w, b) {
    const err = dlg.querySelector('.err'); err.textContent = ''; if (b) b.disabled = true;
    try {
      const { addr, request } = await connect(w, dlg); if (!addr) throw new Error('The wallet did not share an account.');
      const n = await (await fetch('/api/pfauth?nonce=1')).json();
      let sig = await request({ type: 'wallet_signTypedData', params: n.typedData });
      if (sig && !Array.isArray(sig)) sig = sig.signature || [sig.r, sig.s]; // some wallets return { r, s }
      const r = await fetch('/api/pfauth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: addr, signature: sig.map(x => typeof x === 'bigint' ? '0x' + x.toString(16) : String(x)), nonce: n.nonce }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Sign-in failed.');
      me = j.address; state = j.state; if (dlg.open) dlg.close(); render(); emit();
    } catch (e) {
      if (!dlg.open) dlg.showModal();
      err.textContent = /reject|cancel|abort|denied|declin/i.test(e?.message || '') || e?.code === 4001 ? 'Cancelled in the wallet.' : (e?.message || 'Sign-in failed.');
    } finally { if (b) b.disabled = false; }
  }
  async function signOut() {
    try { await fetch('/api/pfauth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ logout: true }) }); } catch {}
    me = null; state = null; if (menu) menu.hidden = true; render(); emit();
  }

  window.DegenzAccount = { ready, get address() { return me; }, get state() { return state; }, signIn: () => openWallets(), signOut };

  async function init() {
    build(); render();
    try { const r = await fetch('/api/pfauth'); if (r.ok) { const j = await r.json(); me = j.address; state = j.state; } } catch {}
    render(); readyResolve({ address: me, state }); emit();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

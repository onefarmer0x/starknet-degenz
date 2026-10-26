// Full-screen "loading the pack" screen. Shown once per browser session, removed as soon as the page has loaded
// (never before 900ms so it doesn't just flash, never after 5s so a slow request can't trap anyone).
(function () {
  var seen = false;
  try { seen = sessionStorage.getItem('degenz.loaded') === '1'; } catch (e) {}
  if (seen) return;
  try { sessionStorage.setItem('degenz.loaded', '1'); } catch (e) {}

  var dark = document.documentElement.getAttribute('data-mode') === 'dark';
  var LINES = ['LOADING THE PACK', 'STOKING THE FIRE', 'COUNTING THE WOLVES', 'WARMING UP THE CHART', 'SNIFFING STARKNET'];
  var el = document.createElement('div');
  el.id = 'loader';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML =
    '<div class="ld-box">' +
      '<video class="ld-wolf" src="' + (dark ? '/wolves/dark.webm' : '/wolves/10.webm') + '" autoplay loop muted playsinline></video>' +
      '<div class="ld-title">$DEGENZ</div>' +
      '<div class="ld-bar"><span id="ldFill"></span></div>' +
      '<div class="ld-row"><span id="ldLine">' + LINES[0] + '</span><b id="ldPct">0%</b></div>' +
    '</div>';
  document.documentElement.appendChild(el);
  document.documentElement.classList.add('is-loading');

  var start = Date.now(), pct = 0, done = false, line = 0;
  function set(p) {
    pct = Math.max(pct, Math.min(100, p));
    var f = document.getElementById('ldFill'), t = document.getElementById('ldPct');
    if (f) f.style.width = pct + '%';
    if (t) t.textContent = Math.round(pct) + '%';
  }
  // creep toward 90% while the page loads, faster at first
  var tick = setInterval(function () {
    if (done) return;
    set(pct + (90 - pct) * 0.08);
    var n = Math.min(LINES.length - 1, Math.floor(pct / 20));
    if (n !== line) { line = n; var l = document.getElementById('ldLine'); if (l) l.textContent = LINES[n]; }
  }, 80);

  function finish() {
    if (done) return;
    done = true;
    var wait = Math.max(0, 900 - (Date.now() - start));
    setTimeout(function () {
      set(100);
      var l = document.getElementById('ldLine'); if (l) l.textContent = 'AWOOOOO';
      setTimeout(function () {
        clearInterval(tick);
        el.classList.add('ld-out');
        document.documentElement.classList.remove('is-loading');
        setTimeout(function () { el.remove(); }, 600);
      }, 350);
    }, wait);
  }
  if (document.readyState === 'complete') finish();
  else window.addEventListener('load', finish);
  setTimeout(finish, 5000);
})();

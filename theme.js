// Light / dark mode switch shared by every page. Loaded in <head> so the saved mode applies before first paint.
(function () {
  var KEY = 'degenz.mode';
  // Dark is the only mode for now: the light version and its toggle are hidden. Set LIGHT_ENABLED = true to bring them back.
  var LIGHT_ENABLED = false;
  if (!LIGHT_ENABLED) document.write('<style>#modeToggle{display:none!important}</style>');
  function saved() { if (!LIGHT_ENABLED) return 'dark'; try { var m = localStorage.getItem(KEY); return m === 'degen' ? 'dark' : m; } catch (e) { return null; } }
  function apply(mode) {
    document.documentElement.setAttribute('data-mode', mode === 'dark' ? 'dark' : 'light');
    var b = document.getElementById('modeToggle');
    if (b) {
      var dark = mode === 'dark';
      b.setAttribute('aria-checked', String(dark));
      b.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    }
    // pages lazy-load heavy assets that only one mode shows
    document.querySelectorAll('video[data-mode-src]').forEach(function (v) {
      if (v.getAttribute('data-mode-src-for') === mode && !v.src) { v.src = v.getAttribute('data-mode-src'); v.play && v.play().catch(function () {}); }
    });
    document.dispatchEvent(new CustomEvent('modechange', { detail: mode }));
  }
  apply(saved());
  document.addEventListener('DOMContentLoaded', function () {
    apply(saved());
    var b = document.getElementById('modeToggle');
    if (!b) return;
    b.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-mode') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next);
    });
  });
})();

// analytics: every BUY $DEGENZ click, with the page it came from
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a.buy, a.buyc, #buyNav, a[href*="launchpad/token"]');
  if (a && window.dzTrack) window.dzTrack('Buy click', { page: location.pathname, spot: a.classList.contains('buyc') ? 'dock' : a.closest('.topnav') ? 'top bar' : 'page' });
}, true);

// Phones: a bottom dock with the main pages and a big BUY coin in the middle (CSS shows it under 640px).
document.addEventListener('DOMContentLoaded', function () {
  var nav = document.querySelector('.topnav'); if (!nav || document.querySelector('.dock')) return;
  var path = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  var items = [['/', '🏠', 'Home'], ['/#chart', '📊', 'Chart'], null, ['/race', '🏁', 'Race'], ['/bonfire', '🔥', 'Bonfire']];
  var dock = document.createElement('nav'); dock.className = 'dock'; dock.setAttribute('aria-label', 'Quick menu');
  items.forEach(function (it) {
    var a = document.createElement('a');
    if (!it) {
      var src = document.getElementById('buyNav') || nav.querySelector('.buy');
      a.className = 'buyc'; a.target = '_blank'; a.rel = 'noopener'; a.href = src ? src.href : 'https://brothereli.com/launchpad';
      a.innerHTML = '<span class="coin">BUY</span><small>$DEGENZ</small>';
      // the page may set the real link after load: always use the top BUY button's current href
      a.addEventListener('pointerdown', function () { if (src) a.href = src.href; a.classList.remove('flip'); void a.offsetWidth; a.classList.add('flip'); if (navigator.vibrate) navigator.vibrate(18); });
    } else {
      a.href = it[0]; a.innerHTML = '<span class="i">' + it[1] + '</span>' + it[2];
      var p = it[0].split('#')[0];
      if (p === path && !(it[0].indexOf('#') > 0)) a.className = 'on';
    }
    dock.appendChild(a);
  });
  document.body.appendChild(dock); document.body.classList.add('has-dock');
});

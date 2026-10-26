// Light / dark mode switch shared by every page. Loaded in <head> so the saved mode applies before first paint.
(function () {
  var KEY = 'degenz.mode';
  function saved() { try { var m = localStorage.getItem(KEY); return m === 'degen' ? 'dark' : m; } catch (e) { return null; } }
  function apply(mode) {
    document.documentElement.setAttribute('data-mode', mode === 'dark' ? 'dark' : 'light');
    var b = document.getElementById('modeToggle');
    if (b) {
      var dark = mode === 'dark';
      b.setAttribute('aria-pressed', String(dark));
      b.textContent = dark ? 'LIGHT MODE' : 'DARK MODE';
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

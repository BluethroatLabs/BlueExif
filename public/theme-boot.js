// Applies the saved appearance (or the OS preference) before first paint.
// Kept as an external file so the Content-Security-Policy needs no inline script.
(function () {
  var t = null;
  try {
    t = localStorage.getItem('blueexif.theme');
  } catch (_) {}
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'light' ? '#fafafa' : '#0a0a0a');
})();

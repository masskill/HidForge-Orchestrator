// Applied before first paint to avoid a theme flash. Dark is the product default.
(function () {
  var t = 'dark';
  try { t = localStorage.getItem('hf-theme') || 'dark'; } catch (e) { /* storage blocked */ }
  if (t === 'system') t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();

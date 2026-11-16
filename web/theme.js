// Applied before first paint to avoid a theme flash.
(function () {
  var t = 'system';
  try { t = localStorage.getItem('hf-theme') || 'system'; } catch (e) { /* storage blocked */ }
  if (t !== 'system') document.documentElement.setAttribute('data-theme', t);
})();

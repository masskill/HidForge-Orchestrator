// HidForge appearance: 10 palettes × dark/light + system. Runs in <head> before the first paint, so there is no theme flash.
// Palette colors live only in styles/tokens.css; this file stores the choice and sets data-hf-style / data-hf-mode
// (the effective mode) on <html>. The app reads and changes it through window.HFTheme.
(function () {
  var STYLES = [
    { id: 'obsidian-orange', name: 'Obsidian Orange', text: 'Преміальний, енергійний, технічний. Фірмовий стиль HidForge.' },
    { id: 'nordic-blue', name: 'Nordic Blue', text: 'Спокійний, професійний, інженерний. Для таблиць і довгої роботи.' },
    { id: 'royal-violet', name: 'Royal Violet', text: 'Інтелектуальний, AI-first, сучасний.' },
    { id: 'slate-lime', name: 'Slate Lime', text: 'Сміливий, точний, висококонтрастний.' },
    { id: 'arctic-teal', name: 'Arctic Teal', text: 'Чистий, свіжий, неконфліктний.' },
    { id: 'champagne-gold', name: 'Champagne Gold', text: 'Стриманий, преміальний, теплий. Для звітів і витрат.' },
    { id: 'berry-noir', name: 'Berry Noir', text: 'Креативний, теплий, сучасний.' },
    { id: 'evergreen', name: 'Evergreen', text: 'Надійний, природний, доброзичливий.' },
    { id: 'deep-ocean', name: 'Deep Ocean', text: 'Аналітичний, глибокий, технічний. Для метрик і графіків.' },
    { id: 'crimson-steel', name: 'Crimson Steel', text: 'Рішучий, строгий, мінімалістичний.' },
  ];
  var MODES = ['system', 'dark', 'light'];
  var DEFAULT = { styleId: 'obsidian-orange', mode: 'system' };
  var STYLE_KEY = 'hidforge.ui.style', MODE_KEY = 'hidforge.ui.mode', OLD_KEY = 'hf-theme';
  var ids = STYLES.map(function (s) { return s.id; });
  var os = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function read() {
    var style = get(STYLE_KEY), mode = get(MODE_KEY);
    // Migration from the old dark/light/system switch (key "hf-theme"): keep the user's mode, style becomes the default.
    if (mode === null) { var old = get(OLD_KEY); if (MODES.indexOf(old) >= 0) { mode = old; put(MODE_KEY, old); } }
    return { styleId: ids.indexOf(style) >= 0 ? style : DEFAULT.styleId, mode: MODES.indexOf(mode) >= 0 ? mode : DEFAULT.mode };
  }
  var cur = read();
  function effective() { return cur.mode !== 'system' ? cur.mode : os && !os.matches ? 'light' : 'dark'; }
  function state() { return { styleId: cur.styleId, mode: cur.mode, effective: effective() }; }
  function apply() {
    var root = document.documentElement;
    root.setAttribute('data-hf-style', cur.styleId);
    root.setAttribute('data-hf-mode', effective());
    window.dispatchEvent(new CustomEvent('hf-appearance', { detail: state() }));
  }
  function set(patch) {
    var next = { styleId: patch.styleId || cur.styleId, mode: patch.mode || cur.mode };
    if (ids.indexOf(next.styleId) < 0 || MODES.indexOf(next.mode) < 0) return state();
    cur = next;
    put(STYLE_KEY, cur.styleId); put(MODE_KEY, cur.mode);
    apply();
    return state();
  }

  if (os) { var onOs = function () { if (cur.mode === 'system') apply(); }; os.addEventListener ? os.addEventListener('change', onOs) : os.addListener(onOs); }
  // Another tab changed the choice.
  window.addEventListener('storage', function (e) { if (e.key === STYLE_KEY || e.key === MODE_KEY || e.key === null) { cur = read(); apply(); } });

  window.HFTheme = { STYLES: STYLES, MODES: MODES, DEFAULT: DEFAULT, get: state, set: set, reset: function () { return set(DEFAULT); } };
  apply();
})();

// Appearance: the palette catalog in tokens.css (10 styles × dark/light) and the theme manager in web/theme.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const css = readFileSync(new URL('../web/styles/tokens.css', import.meta.url), 'utf8');
const themeJs = readFileSync(new URL('../web/theme.js', import.meta.url), 'utf8');
const REQUIRED = ['bg', 'surface', 'text', 'muted', 'accent', 'on-accent', 'text-secondary', 'accent-fill'];

const palettes = [...css.matchAll(/\[data-hf-style="([\w-]+)"\]\[data-hf-mode="(dark|light)"\] \{([^}]+)\}/g)].map((m) => {
  const vars = Object.fromEntries([...m[3].matchAll(/--hf-([\w-]+): ([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
  const hex = (k: string): string => { const v = vars[k]!; return v.startsWith('var(--hf-') ? hex(v.slice(9, -1)) : v; };
  return { style: m[1]!, mode: m[2]!, vars, hex };
});

/** Run theme.js in a fake browser; returns window.HFTheme, the <html> attributes and the storage. */
function boot(stored: Record<string, string> = {}, osDark = true) {
  const store = new Map(Object.entries(stored));
  const attrs: Record<string, string> = {};
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const win: Record<string, unknown> = {
    matchMedia: () => ({ matches: osDark, addEventListener: () => {} }),
    addEventListener: (t: string, f: (e: unknown) => void) => { (listeners[t] ??= []).push(f); },
    dispatchEvent: () => true,
  };
  const ctx = vm.createContext({
    window: win, CustomEvent: class { type: string; constructor(type: string) { this.type = type; } },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
    document: { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } } },
  });
  vm.runInContext(themeJs, ctx);
  return { T: win.HFTheme as { STYLES: { id: string }[]; get(): { styleId: string; mode: string; effective: string }; set(p: object): unknown; reset(): unknown }, attrs, store, listeners };
}

const lum = (hex: string) => {
  const c = hex.slice(1).match(/../g)!.map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

test('themes: 10 styles × dark/light in tokens.css, the same ids as the picker, every required token', () => {
  const { T } = boot();
  const ids = T.STYLES.map((s) => s.id);
  assert.equal(ids.length, 10);
  assert.equal(palettes.length, 20);
  for (const id of ids) for (const mode of ['dark', 'light']) {
    const p = palettes.find((x) => x.style === id && x.mode === mode);
    assert.ok(p, `${id}/${mode} is defined`);
    for (const k of REQUIRED) assert.match(p.hex(k), /^#[0-9A-F]{6}$/i, `${id}/${mode} --hf-${k}`);
  }
  assert.equal(palettes.find((p) => p.style === 'arctic-teal' && p.mode === 'light')!.hex('accent-fill'), '#008477', 'documented a11y fill');
});

test('themes: text, secondary text and the primary button stay readable (WCAG 4.5:1) in all 20 palettes', () => {
  for (const p of palettes) {
    const at = `${p.style}/${p.mode}`;
    for (const bg of ['bg', 'surface']) {
      assert.ok(contrast(p.hex('text'), p.hex(bg)) >= 7, `${at} text on ${bg}`);
      assert.ok(contrast(p.hex('text-secondary'), p.hex(bg)) >= 4.5, `${at} text-secondary on ${bg}`);
    }
    assert.ok(contrast(p.hex('on-accent'), p.hex('accent-fill')) >= 4.5, `${at} on-accent on the button`);
  }
});

test('theme manager: default, migration of the old switch, saving, invalid values, reset', () => {
  let b = boot({}, false);
  assert.deepEqual({ ...b.T.get() }, { styleId: 'obsidian-orange', mode: 'system', effective: 'light' }, 'new install: default + system (OS light)');
  assert.deepEqual(b.attrs, { 'data-hf-style': 'obsidian-orange', 'data-hf-mode': 'light' });

  b = boot({ 'hf-theme': 'light' });
  assert.equal(b.T.get().mode, 'light', 'old saved theme kept');
  assert.equal(b.store.get('hidforge.ui.mode'), 'light', 'migrated to the new key');

  b = boot({ 'hidforge.ui.style': 'no-such-style', 'hidforge.ui.mode': 'neon' });
  assert.deepEqual({ ...b.T.get() }, { styleId: 'obsidian-orange', mode: 'system', effective: 'dark' }, 'garbage in storage falls back to defaults');

  b.T.set({ styleId: 'deep-ocean', mode: 'light' });
  assert.equal(b.attrs['data-hf-style'], 'deep-ocean');
  assert.equal(b.attrs['data-hf-mode'], 'light');
  assert.equal(b.store.get('hidforge.ui.style'), 'deep-ocean');
  b.T.set({ styleId: 'hotpink' });
  assert.equal(b.T.get().styleId, 'deep-ocean', 'unknown style ignored');

  // Another tab saved a new choice.
  b.store.set('hidforge.ui.style', 'evergreen');
  for (const f of b.listeners.storage ?? []) f({ key: 'hidforge.ui.style' });
  assert.equal(b.attrs['data-hf-style'], 'evergreen');

  b.T.reset();
  assert.deepEqual({ ...b.T.get() }, { styleId: 'obsidian-orange', mode: 'system', effective: 'dark' });
});

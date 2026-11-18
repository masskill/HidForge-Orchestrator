// The UI scripts must parse: one stray quote in web/app.js leaves the whole interface empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

test('every web/*.js file is valid JavaScript', () => {
  for (const f of readdirSync(web).filter((x) => x.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', path.join(web, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

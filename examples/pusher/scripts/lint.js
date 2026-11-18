// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)
// SPDX-License-Identifier: Apache-2.0

/**
 * Dependency-free lint: `node --check` every source file, and require the SPDX header on each.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['bin', 'src', 'test', 'scripts'];
const HEADER = ['// Copyright 2026 Sats Labs Inc. (d/b/a Palladium Labs)', '// SPDX-License-Identifier: Apache-2.0'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.js') ? [p] : [];
  });
}

let failed = 0;
const files = DIRS.flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d)) : []));
for (const f of files) {
  const rel = path.relative(ROOT, f);
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`syntax: ${rel}\n${e.stderr}`);
    continue;
  }
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const start = lines[0].startsWith('#!') ? 1 : 0;
  if (lines[start] !== HEADER[0] || lines[start + 1] !== HEADER[1]) {
    failed++;
    console.error(`header: ${rel} is missing the Apache-2.0 SPDX header`);
  }
}
if (failed) {
  console.error(`lint: ${failed} problem(s) in ${files.length} files`);
  process.exit(1);
}
console.log(`lint: ${files.length} files ok`);

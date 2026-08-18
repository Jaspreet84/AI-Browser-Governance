/**
 * Project conventions check. Not a general-purpose linter — it enforces the few
 * invariants that would silently break this extension.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const problems = [];
const files = [];

const walk = (p) => {
  for (const entry of readdirSync(p)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = join(p, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(js|mjs)$/.test(full)) files.push(full);
  }
};
walk(join(root, 'src'));
walk(join(root, 'tools'));
walk(join(root, 'tests'));

const rel = (f) => f.slice(root.length);

/** Strip comments so prose about `chrome.*` is not mistaken for code. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const src = stripComments(raw);
  const isContentScript = /src\/content\//.test(file);
  const isCore = /src\/core\//.test(file);

  if (isCore && /\bchrome\./.test(src)) {
    problems.push(`${rel(file)}: core modules must stay free of chrome.* so they remain testable`);
  }
  if (isContentScript && /^\s*(import|export)\s/m.test(src)) {
    problems.push(`${rel(file)}: content scripts cannot use ES module syntax (manifest injects them as classic scripts)`);
  }
  if (/\bdebugger;/.test(src)) problems.push(`${rel(file)}: stray debugger statement`);
  if (/console\.log\(/.test(src) && !/tools\//.test(file)) {
    problems.push(`${rel(file)}: console.log in shipped code (use console.warn/error for real problems)`);
  }
  if (/\.innerHTML\s*=/.test(src) && !/src\/content\/overlay\.js|src\/ui\/options\/options\.js/.test(file)) {
    problems.push(`${rel(file)}: innerHTML assignment outside the audited UI files`);
  }
}

/* Manifest ↔ disk consistency. */
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  manifest.storage.managed_schema,
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
];
for (const path of referenced) {
  if (!existsSync(join(root, path))) problems.push(`manifest.json references a missing file: ${path}`);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version) {
  problems.push(`version drift: package.json ${pkg.version} vs manifest.json ${manifest.version}`);
}

/* Parse every module without evaluating it. */
try {
  execFileSync(process.execPath, ['--experimental-vm-modules', join(root, 'tools/syntax-check.mjs'), 'src', 'tools', 'tests'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  problems.push(`syntax check failed:\n${e.stdout?.toString() || ''}${e.stderr?.toString() || ''}`);
}

if (problems.length) {
  console.error(`${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.error(`lint ok — ${files.length} files, manifest consistent`);

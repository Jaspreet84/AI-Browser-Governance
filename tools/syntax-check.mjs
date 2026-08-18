/**
 * Parse every JS file as an ES module without evaluating it, so browser-only
 * globals (chrome.*, window) do not have to exist for the check to run.
 * Usage: node --experimental-vm-modules tools/syntax-check.mjs src tools
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const roots = process.argv.slice(2);
const files = [];
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
  else if (/\.(js|mjs)$/.test(p)) files.push(p);
};
roots.forEach(walk);

let bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  try {
    // eslint-disable-next-line no-new
    new vm.SourceTextModule(src, { identifier: f });
  } catch (e) {
    console.error(`SYNTAX  ${f}: ${e.message}`);
    bad += 1;
  }
}
console.log(`${files.length} files parsed, ${bad} syntax error(s)`);
process.exit(bad ? 1 : 0);

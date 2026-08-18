/** Build a loadable/uploadable zip of the extension, excluding development files. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;
const out = join(root, 'dist', `ai-browser-governance-${version}.zip`);

mkdirSync(join(root, 'dist'), { recursive: true });
rmSync(out, { force: true });

const include = ['manifest.json', 'managed-schema.json', 'src', 'assets', 'README.md', 'docs'];
execFileSync('zip', ['-r', '-q', out, ...include, '-x', '*.DS_Store'], { cwd: root, stdio: 'inherit' });
console.error(`packaged ${out.slice(root.length)}`);

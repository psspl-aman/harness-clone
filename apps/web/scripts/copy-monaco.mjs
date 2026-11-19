// Copies Monaco's prebuilt AMD bundle into public/ so the Code tab loads it
// from this app (no CDN). Runs before `dev` and `build`; skipped when current.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The package's exports map hides package.json, so resolve it from node_modules directly.
const pkgPath = join(here, '..', 'node_modules', 'monaco-editor', 'package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
const src = join(dirname(pkgPath), 'min', 'vs');
const out = join(here, '..', 'public', 'monaco');
const stamp = join(out, 'VERSION');

if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) process.exit(0);
rmSync(out, { recursive: true, force: true });
cpSync(src, join(out, 'vs'), { recursive: true });
writeFileSync(stamp, version);
process.stdout.write(`monaco-editor ${version} copied to public/monaco\n`);

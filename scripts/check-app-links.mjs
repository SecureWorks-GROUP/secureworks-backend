#!/usr/bin/env node
// Static link-resolution check for apps/<name>/.
//
// For each app, parse every local reference (HTML src/href, CSS/inline url(),
// and JS import/import()) and assert it resolves to a file that exists on disk
// INSIDE the app's own directory. Fails if any path is missing or uses `../`
// to escape the app boundary.
//
// This is exhaustive by design — it covers references regardless of whether a
// runtime user journey would request them (lazy/conditional assets included).
//
// Usage:
//   node scripts/check-app-links.mjs                 # all apps under apps/
//   node scripts/check-app-links.mjs fencing-site    # a single app

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appsRoot = join(repoRoot, 'apps');

// References to ignore: external hosts, data/blob URIs, anchors, protocol-only,
// and absolute site-root paths (those are a routing concern validated on a real
// deploy, not an on-disk in-app file).
const isExternal = (ref) =>
  /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(ref) || // http://, https://, //
  /^(data|blob|mailto|tel|javascript):/i.test(ref) ||
  ref.startsWith('#') ||
  ref.startsWith('/') || // absolute, site-root relative — routing layer
  ref.trim() === '';

// Only static asset / code references are checkable on disk. Restricting to a
// known extension set filters out JS runtime expressions and placeholder
// strings (e.g. `${p.dataUrl}`, `blob`, `image/png`, `YOUR_GHL_FORM_URL`) that
// the naive src=/url()/import scan would otherwise pick up from inline scripts.
const ASSET_EXTS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.mov', '.pdf',
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// Extract candidate references from a file based on its type.
function extractRefs(file, text) {
  const refs = new Set();
  const ext = extname(file).toLowerCase();

  const add = (m) => { if (m) refs.add(m); };

  if (ext === '.html' || ext === '.htm') {
    // src="..." / href="..." (single or double quoted)
    for (const m of text.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)) add(m[1]);
    for (const m of text.matchAll(/\b(?:src|href)\s*=\s*'([^']*)'/gi)) add(m[1]);
  }

  if (['.html', '.htm', '.css'].includes(ext)) {
    // url(...) in <style> blocks, style="" attributes, or .css files
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) add(m[1]);
  }

  if (['.js', '.mjs', '.html', '.htm'].includes(ext)) {
    // static imports: import ... from '...'  /  import '...'
    for (const m of text.matchAll(/\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) add(m[1]);
    // dynamic imports: import('...')
    for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
  }

  return [...refs];
}

function checkApp(appName) {
  const appDir = join(appsRoot, appName);
  if (!existsSync(appDir) || !statSync(appDir).isDirectory()) {
    return { appName, errors: [`app directory not found: ${relative(repoRoot, appDir)}`], checked: 0 };
  }

  const errors = [];
  let checked = 0;

  for (const file of walk(appDir)) {
    const ext = extname(file).toLowerCase();
    if (!['.html', '.htm', '.css', '.js', '.mjs'].includes(ext)) continue;

    const text = readFileSync(file, 'utf8');
    for (const ref of extractRefs(file, text)) {
      // strip query string / hash fragment
      const clean = ref.split(/[?#]/)[0];
      if (isExternal(clean) || clean === '') continue;
      // skip non-path runtime/template noise and only check known asset types
      if (/[`${}()\[\]<>]/.test(clean)) continue;
      if (!ASSET_EXTS.has(extname(clean).toLowerCase())) continue;

      checked++;
      const target = resolve(dirname(file), clean);
      const where = relative(repoRoot, file);

      // boundary check: target must stay within the app directory
      const rel = relative(appDir, target);
      if (rel.startsWith('..')) {
        errors.push(`[${where}] reference "${ref}" escapes app boundary -> ${relative(repoRoot, target)}`);
        continue;
      }
      if (!existsSync(target)) {
        errors.push(`[${where}] reference "${ref}" -> missing file ${relative(repoRoot, target)}`);
      }
    }
  }

  return { appName, errors, checked };
}

const requested = process.argv.slice(2);
const apps = requested.length
  ? requested
  : readdirSync(appsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

let failed = false;
for (const app of apps) {
  const { errors, checked } = checkApp(app);
  if (errors.length) {
    failed = true;
    console.error(`✖ ${app}: ${errors.length} problem(s), ${checked} local ref(s) checked`);
    for (const e of errors) console.error(`    ${e}`);
  } else {
    console.log(`✓ ${app}: all ${checked} local reference(s) resolve within the app boundary`);
  }
}

process.exit(failed ? 1 : 0);

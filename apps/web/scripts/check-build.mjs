// Local stand-in for the Lighthouse installability audit (which needs the deployed build,
// M0-02): after `vite build`, check that the manifest and the service worker are emitted
// with the fields browsers require before they offer to install the app.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const problems = [];

function check(condition, message) {
  if (!condition) problems.push(message);
}

function read(file) {
  const path = join(dist, file);
  if (!existsSync(path)) {
    problems.push(`dist/${file} is missing`);
    return undefined;
  }
  return readFileSync(path, 'utf8');
}

const manifestText = read('manifest.webmanifest');
if (manifestText !== undefined) {
  const manifest = JSON.parse(manifestText);
  for (const field of ['name', 'short_name', 'id', 'start_url', 'scope', 'theme_color']) {
    check(
      typeof manifest[field] === 'string' && manifest[field] !== '',
      `manifest.${field} is missing`,
    );
  }
  check(manifest.display === 'standalone', 'manifest.display must be "standalone"');
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const purposes = (icon) => (icon.purpose ?? 'any').split(' ');
  const hasIcon = (size, purpose) =>
    icons.some((icon) => icon.sizes === size && purposes(icon).includes(purpose));
  check(hasIcon('192x192', 'any'), 'manifest needs a 192x192 icon');
  check(hasIcon('512x512', 'any'), 'manifest needs a 512x512 icon');
  check(hasIcon('512x512', 'maskable'), 'manifest needs a 512x512 maskable icon');
  for (const icon of icons) {
    check(existsSync(join(dist, icon.src.replace(/^\//, ''))), `icon ${icon.src} is not in dist/`);
  }
}

const sw = read('sw.js');
if (sw !== undefined) {
  check(!sw.includes('self.__WB_MANIFEST'), 'sw.js still holds the precache placeholder');
  // Registered as a classic script: module syntax would fail to evaluate.
  check(!/(^|[;}\s])(export|import)\s*[{*]/.test(sw), 'sw.js contains module syntax');
  const precache = /\[\{"revision".*?\}\]/.exec(sw);
  check(precache !== null, 'sw.js has no precache list');
  if (precache !== null) {
    const urls = JSON.parse(precache[0]).map((entry) => entry.url);
    check(urls.includes('index.html'), 'sw.js does not precache index.html');
    const duplicates = urls.filter((url, index) => urls.indexOf(url) !== index);
    check(duplicates.length === 0, `sw.js precaches twice: ${duplicates.join(', ')}`);
  }
}

const html = read('index.html');
if (html !== undefined) {
  check(
    /<link[^>]+rel="manifest"[^>]+href="\/manifest\.webmanifest"/.test(html),
    'index.html does not link the manifest',
  );
  check(html.includes('viewport-fit=cover'), 'index.html viewport lacks viewport-fit=cover');
  check(html.includes('registerSW.js'), 'index.html does not register the service worker');
}

if (problems.length > 0) {
  process.stderr.write(`PWA build check failed:\n- ${problems.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write('PWA build check: manifest, icons and service worker OK\n');

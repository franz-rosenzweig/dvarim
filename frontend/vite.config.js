import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// The service worker (public/sw.js) is told every file the build made, and a
// name for the build, so it can keep all of them for when there is no network
// and so each build installs afresh. Done once the files are written.
function precache() {
  return {
    name: 'dvarim-precache',
    apply: 'build',
    writeBundle(options) {
      const out = options.dir;
      const files = [];
      const walk = (d) => {
        for (const name of readdirSync(d)) {
          const p = join(d, name);
          if (statSync(p).isDirectory()) walk(p);
          else files.push('/' + relative(out, p).split('\\').join('/'));
        }
      };
      walk(out);
      const keep = files.filter((f) => f !== '/sw.js' && !f.endsWith('.map')).sort();
      const build = createHash('sha256').update(keep.map((f) => f + readFileSync(join(out, f))).join('|')).digest('hex').slice(0, 12);
      const sw = join(out, 'sw.js');
      const text = readFileSync(sw, 'utf8')
        .replace("const BUILD = 'dev';", `const BUILD = '${build}';`)
        .replace('const FILES = [];', `const FILES = ${JSON.stringify(keep)};`);
      writeFileSync(sw, text);
    },
  };
}

// The engine (../engine) is the page's own backend in local mode; see
// src/lib/backend.js. It is imported only there, and lazily.
const engine = fileURLToPath(new URL('../engine/src', import.meta.url));

export default defineConfig({
  plugins: [svelte(), precache()],
  base: '/',
  resolve: { alias: { '@engine': engine } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020'
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      // The backend (uvicorn dvarim.api:app --port 8420) serves /api; SSE passes through.
      '/api': { target: 'http://localhost:8420', changeOrigin: true }
    }
  }
});

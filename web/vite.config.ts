import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, normalize, sep } from 'node:path';

/**
 * Каталоги оригінальних ігор (лише для локальної розробки; у релізі файли надає гравець):
 * /game/ — Дальнобойщики, /game2/ — Дальнобойщики 2 (Game/Hard Truck 2 — junction на теку встановленої гри).
 */
const GAME_DIRS: Record<string, string> = {
  '/game2': resolve(import.meta.dirname, '..', 'Game', 'Hard Truck 2'),
  '/game': resolve(import.meta.dirname, '..', 'Game', 'Hard Truck'),
};

/**
 * Dev-плагін: віддає файли гри за URL /game/<шлях> і /game2/<шлях> (шляхи — як на диску).
 */
function gameFiles(): Plugin {
  return {
    name: 'game-files',
    configureServer(server) {
      for (const [prefix, dir] of Object.entries(GAME_DIRS)) server.middlewares.use(prefix, (req, res) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
        const full = normalize(resolve(dir, rel));
        if (!full.startsWith(dir + sep) || !existsSync(full) || !statSync(full).isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        // Файли гри незмінні: дозволяємо браузеру кешувати (ETag — розмір і час зміни).
        const st = statSync(full);
        const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        if (req.headers['if-none-match'] === etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(st.size));
        createReadStream(full).pipe(res);
      });
    },
  };
}

/**
 * Збірка: вписує в dist/sw.js список усіх файлів збірки (service worker кешує їх при встановленні — гра працює
 * офлайн одразу після першого відкриття) і версію — хеш їхнього вмісту (нова збірка — новий кеш, оновлення).
 */
function precacheManifest(): Plugin {
  let outDir = 'dist';
  return {
    name: 'precache-manifest',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const sw = join(outDir, 'sw.js');
      if (!existsSync(sw)) return;
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else files.push(relative(outDir, full).split(sep).join('/'));
        }
      };
      walk(outDir);
      const list = files.filter((f) => f !== 'sw.js').sort();
      // Версія — і за файлами збірки, і за самим service worker (зміна лише в ньому — теж нова версія).
      const template = readFileSync(sw, 'utf8');
      const hash = createHash('sha256').update(template);
      for (const f of list) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const urls = ['./', ...list.map((f) => `./${f}`)];
      const src = template
        .replace("'__VERSION__'", JSON.stringify(version))
        .replace('[/* PRECACHE */]', JSON.stringify(urls));
      writeFileSync(sw, src);
    },
  };
}

export default defineConfig({
  // Відносні шляхи: збірка працює з будь-якої теки хостингу (GitHub Pages тощо).
  base: './',
  plugins: [gameFiles(), precacheManifest()],
  server: { host: true, port: 5173 },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});

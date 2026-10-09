import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, normalize, sep } from 'node:path';

/** Каталог оригінальної гри (лише для локальної розробки; у релізі файли надає гравець). */
const GAME_DIR = resolve(import.meta.dirname, '..', 'Game', 'Hard Truck');

/**
 * Dev-плагін: віддає файли гри за URL /game/<шлях> (шляхи — як на диску).
 */
function gameFiles(): Plugin {
  return {
    name: 'game-files',
    configureServer(server) {
      server.middlewares.use('/game', (req, res) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
        const full = normalize(resolve(GAME_DIR, rel));
        if (!full.startsWith(GAME_DIR + sep) || !existsSync(full) || !statSync(full).isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(statSync(full).size));
        createReadStream(full).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // Відносні шляхи: збірка працює з будь-якої теки хостингу (GitHub Pages тощо).
  base: './',
  plugins: [gameFiles()],
  server: { host: true, port: 5173 },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});

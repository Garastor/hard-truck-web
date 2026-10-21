import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, normalize, sep } from 'node:path';

/** Тека оригінальних ігор (HT_GAME_ROOT — інша, напр. з git worktree — тека основної копії). */
const GAME_ROOT = process.env.HT_GAME_ROOT ?? resolve(import.meta.dirname, '..', 'Game');

/**
 * Каталоги оригінальних ігор (лише для локальної розробки; у релізі файли надає гравець):
 * /game/ — Дальнобойщики, /game2/ — Дальнобойщики 2 (Game/Hard Truck 2 — junction на теку встановленої гри).
 */
const GAME_DIRS: Record<string, string> = {
  '/game2': resolve(GAME_ROOT, 'Hard Truck 2'),
  '/game': resolve(GAME_ROOT, 'Hard Truck'),
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
 * Теки-входи для прямого запуску гри: /ht1/ — «Дальнобойщики», /ht2/ — «Дальнобойщики 2» (GitHub Pages — статичний
 * хостинг, тож це справжні сторінки). Сторінка — копія index.html з відносними шляхами на рівень вище і власним
 * manifest (назва, start_url — ця тека; scope — увесь порт, щоб «Вихід» до вибору гри лишався в застосунку).
 * На iPhone кожна гра — окрема іконка на головному екрані. Гру за адресою визначає games/registry.ts.
 */
interface Entry {
  title: string;
  description: string;
  /** Префікс іконок у public/ (icon-192.png…); значок спільний для обох ігор — Kenworth на фіолетовому тлі. */
  icon: string;
}
const ENTRIES: Record<string, Entry> = {
  ht1: { title: 'Дальнобойщики', description: 'Порт «Дальнобійників» (1998) у браузер. Потрібні файли оригінальної гри.', icon: 'icon' },
  ht2: { title: 'Дальнобойщики 2', description: 'Порт «Дальнобійників 2» (2001) у браузер. Потрібні файли оригінальної гри.', icon: 'icon' },
};

function entryHtml(html: string, e: Entry): string {
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${e.title}</title>`)
    .replace(/\b(href|src)="([^"]+)"/g, (m, attr: string, url: string) => {
      if (/^(\/|[a-z]+:|#|data:)/i.test(url) || /^(\.\/)?manifest\.webmanifest$/.test(url)) return m;
      return `${attr}="../${url.replace(/^\.\//, '').replace(/^icon-(\d+)\.png$/, `${e.icon}-$1.png`)}"`;
    });
}

function entryManifest(rootManifest: string, e: Entry): string {
  const m = JSON.parse(rootManifest) as { icons?: { src: string }[] } & Record<string, unknown>;
  return JSON.stringify(
    {
      ...m,
      name: e.title,
      short_name: e.title,
      description: e.description,
      start_url: './',
      scope: '../',
      id: './',
      icons: m.icons?.map((i) => ({ ...i, src: `../${i.src.replace(/^icon-/, `${e.icon}-`)}` })),
    },
    null,
    2,
  );
}

function gameEntries(): Plugin {
  return {
    name: 'game-entries',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '/').split('?')[0];
        const m = /^\/(ht[12])(\/|\/index\.html|\/manifest\.webmanifest)?$/.exec(url);
        if (!m) return next();
        const entry = ENTRIES[m[1]];
        if (!m[2]) {
          res.statusCode = 302;
          res.setHeader('Location', `/${m[1]}/${(req.url ?? '').slice(url.length)}`);
          return res.end();
        }
        if (m[2].endsWith('manifest.webmanifest')) {
          res.setHeader('Content-Type', 'application/manifest+json');
          return res.end(entryManifest(readFileSync(resolve(import.meta.dirname, 'public', 'manifest.webmanifest'), 'utf8'), entry));
        }
        const html = entryHtml(readFileSync(resolve(import.meta.dirname, 'index.html'), 'utf8'), entry);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(await server.transformIndexHtml(req.url ?? url, html));
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
      // Спершу теки-входи /ht1/, /ht2/ — вони теж у списку для офлайн-кешу.
      const indexHtml = readFileSync(join(outDir, 'index.html'), 'utf8');
      const rootManifest = readFileSync(join(outDir, 'manifest.webmanifest'), 'utf8');
      for (const [id, entry] of Object.entries(ENTRIES)) {
        mkdirSync(join(outDir, id), { recursive: true });
        writeFileSync(join(outDir, id, 'index.html'), entryHtml(indexHtml, entry));
        writeFileSync(join(outDir, id, 'manifest.webmanifest'), entryManifest(rootManifest, entry));
      }
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
      const urls = ['./', ...Object.keys(ENTRIES).map((id) => `./${id}/`), ...list.map((f) => `./${f}`)];
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
  plugins: [gameFiles(), gameEntries(), precacheManifest()],
  // Частини коду (Docs/09-structure-plan.md): спільний рушій, оболонка, ігри.
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@app': resolve(import.meta.dirname, 'src/app'),
      '@ht1': resolve(import.meta.dirname, 'src/games/ht1'),
      '@ht2': resolve(import.meta.dirname, 'src/games/ht2'),
    },
  },
  server: { host: true, port: 5173 },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});

/** Звідки брати файли гри: dev-сервер ПК, IndexedDB на пристрої (gameStore.ts) або кеш між ними. */
export interface FileSource {
  read(path: string): Promise<Uint8Array>;
}

/** Файли гри з dev-сервера ПК за префіксом URL (vite.config.ts: `/game/`, `/game2/`). */
export function httpSource(prefix: string): FileSource {
  return {
    async read(path) {
      const res = await fetch(`${prefix}${path.split('/').map(encodeURIComponent).join('/')}`);
      if (!res.ok) throw new Error(`Не вдалося завантажити ${path}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

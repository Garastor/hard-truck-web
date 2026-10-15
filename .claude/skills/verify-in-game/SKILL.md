---
name: verify-in-game
description: Перевірити зміну в грі в браузері Claude (вбудована панель) — окрема вкладка, ht.dev, знімок, мобільний вʼюпорт, прибирання. Використовувати після кожної зміни рендеру, фізики, інтерфейсу чи ігрової логіки Hard Truck Web.
---

# Перевірка в грі

Dev-сервер: `preview_start` з назвою `web` (`.claude/launch.json`), адреса `http://localhost:5173`. Якщо порт 5173
зайнятий сервером іншої сесії тієї самої теки — не зупиняти його: `preview_start({ url: 'http://localhost:5173/' })`
(той самий код). Окремий сервер — `web-alt` (5174; інше походження — окреме localStorage й IndexedDB: збереження
користувача не зачіпаються, але файли гри йдуть з dev-сервера).

## Правила
- **Вкладку користувача не чіпати** (не перезавантажувати, не навігувати): він там грає. Перевіряти в **новій**
  вкладці (`tabs_create`), наперед виводити її (`tabs_select`) лише на час знімка, після — закрити й повернути
  вкладку користувача (`tabs_select`).
- Зміни в `sceneBuilder.ts`/`collision.ts`/`drive.ts` Vite перезавантажує повністю — у вкладці користувача заїзд
  скинеться; попередити його, що треба перезапустити трасу.
- Схована панель → `requestAnimationFrame` стоїть: для логіки й чисел — `ht.dev.run()`/`drive.update()`
  (синхронно), для знімка — вкладку наперед.

## Порядок
1. `tabs_create` → `navigate` на `/?tab=drive&level=<COUNT|MOUNT|NIGHT|CIRCUIT|TRIAL|MENU3D>&truck=<1..9>&ai=<0..7>`
   (`&career=1` — кар'єра). Погода тесту береться з localStorage (`ht.testWeather`), задати — через `setup`.
2. `javascript_tool`:
   ```js
   for (let i = 0; i < 50 && !window.ht; i++) await new Promise((r) => setTimeout(r, 200));
   await ht.dev.ready();
   ht.dev.setup({ cam: 'chase' /* | 'cockpit' | 'far' */, weather: 'rain', start: true });
   ht.dev.teleport('room_011');            // або { x, z, heading } у координатах Three.js
   ht.dev.run(10);                         // 10 с автопілотом: кімнати, відстань, застрягання
   ht.dev.still();                         // зупинити перед знімком
   ```
   Регресія руху: `ht.dev.smoke(300)` → `ok: true` (застрягання < 3 с) на кожній зміненій трасі.
3. Знімок: `tabs_select` нової вкладки → `computer screenshot` (дрібне — `zoom`). Числа надійніші за знімок:
   перевіряти властивостями обʼєктів (`ht.drive`, `ht.built`, `ht.scene`).
4. Інтерфейс — у мобільному вʼюпорті: `resize_window` 812×375 (ландшафт iPhone), після — `preset: 'desktop'`.
5. Прибрати: `tabs_close` своєї вкладки, `tabs_select` вкладки користувача.

## Друга гра
- Адреса: `/ht2/?tab=career&mute` (кар'єра), `/ht2/?tab=drive&truck=ZilR&mute` (вільна їзда); `?mute` — завжди в
  тестових вкладках.
- `window.ht2.drive`: `smoke(с)` (автопрохід), `say(текст)` (пейджер), `careerMode` (вікна: `servicePanel(node)`,
  `gasPanel()`, `storePanel(…)`, `fine(over, limit)`), `cards.show(N, …)`, `tablo`, `escArt`.
- `COMMON/esc16.RES` (57 МБ) на першому запуску ще читається — перед перевіркою інтерфейсу оригіналу дочекатися
  `!!window.ht2.drive.escArt`.
- Скріншот вузького вʼюпорта в панелі буває обрізаний праворуч — розміри й положення перевіряти
  `getBoundingClientRect()`, а вигляд — на ширшому вʼюпорті.

## Гілка в git worktree
Тести й dev-сервер worktree читають ігри з `HT_GAME_ROOT` (теки `Game` основної копії): `npm ci` у `web/` worktree,
далі `HT_GAME_ROOT="D:/Claude/Games/Hard Truck/Game" npx vitest run`. Для превʼю — тимчасова конфігурація в
`.claude/launch.json` основної копії (`cmd /c "set HT_GAME_ROOT=…&& C:\PROGRA~1\nodejs\npm.cmd run dev --prefix
.worktrees/<гілка>/web -- --port 5176 --strictPort"`), після перевірки — `git checkout -- .claude/launch.json`.

## Корисне
- `ht.dev.info()` — траса, кімната, позиція, швидкість, камера, погода, режим відблисків.
- `ht.drive.roadBelow(x, y, z)`, `ht.drive.glossAt(x, y, z)` — висота й блиск дороги.
- Модулі можна імпортувати в сторінці: `await import('/src/games/ht1/engine/physics/collision.ts')`.
- Великий результат `javascript_tool` (> ~100 КБ) не повертати — зводити до коротких рядків.

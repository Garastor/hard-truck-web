---
name: launch-own-port
description: Запустити Hard Truck Web (HT1 чи HT2) на СВОЄМУ dev-сервері (порт 5180+) у СВОЇЙ вкладці панелі браузера — для сесії в git worktree чи будь-якої сесії, якій не можна чіпати сервер 5173 і вкладки користувача. Порт, launch.json, HT_GAME_ROOT, розмір вʼюпорта до завантаження (схована панель ламає запуск), очікування без тайм-ауту, прибирання. Використовувати перед перевіркою в грі в окремій сесії, коли бриф каже «свій dev-сервер на порту 518x».
---

# Гра на своєму порту у своїй вкладці

Усе по черзі, без пропусків: кожен крок закриває пастку, на якій запуск уже падав.

## 1. Порт
Порт дає бриф (`parallel-sessions`: 5180, 5181, …). Немає в брифі — взяти перший вільний із 5180+:

```bash
netstat -ano | grep -E ":51[0-9]{2} .*LISTEN"
```

5173/5174 — основна копія, 4173 — превʼю збірки, зайняті 518x — інших сесій: **не зупиняти й не
використовувати**.

## 2. Конфігурація в `.claude/launch.json` СВОЄЇ теки
`preview_start` читає `launch.json` теки сесії (у worktree — `.worktrees/<гілка>/.claude/launch.json`). Додати
запис (PORT — свій):

- **worktree** (тек `Game/` у ньому немає — файли ігор з основної копії через `HT_GAME_ROOT`; один раз перед тим —
  `cd web && "C:/Program Files/nodejs/npm.cmd" ci`):
  ```json
  { "name": "web-PORT", "runtimeExecutable": "cmd",
    "runtimeArgs": ["/c", "set HT_GAME_ROOT=D:/Claude/Games/Hard Truck/Game&& \"C:/Program Files/nodejs/npm.cmd\" run dev --prefix web -- --port PORT --strictPort"],
    "port": PORT }
  ```
  (`&&` — одразу після шляху, без пробілу: інакше пробіл потрапить у змінну.)
- **основна копія** (`Game/` на місці):
  ```json
  { "name": "web-PORT", "runtimeExecutable": "C:/Program Files/nodejs/npm.cmd",
    "runtimeArgs": ["run", "dev", "--prefix", "web", "--", "--port", "PORT", "--strictPort"], "port": PORT }
  ```

Цю правку **не комітити** (наприкінці — `git checkout -- .claude/launch.json`).

## 3. Сервер
`preview_start({ name: 'web-PORT' })`. Він відкриває свою вкладку (`tabId` у відповіді, зазвичай `seed`) —
працювати в ній або створити ще одну (`tabs_create`). Вкладок з іншим портом не чіпати.

## 4. Вкладка: спершу розмір, потім гра
**Пастка:** панель браузера часто схована — тоді вікно сторінки 0×0, і HT2 падає на старті їзди
(`InvalidStateError: … canvas element with a width or height of 0` у `TabMap.draw` ← `Ht2Drive.init`): на екрані
лишається головне меню, `window.ht2.drive` не зʼявляється ніколи. `resize_window` не працює на порожній вкладці
(«This tab is blank»), тож порядок такий — одним `browser_batch`:

```json
[{ "name": "navigate", "input": { "tabId": "<tab>", "url": "http://localhost:PORT/" } },
 { "name": "resize_window", "input": { "tabId": "<tab>", "width": 1000, "height": 600 } },
 { "name": "navigate", "input": { "tabId": "<tab>", "url": "http://localhost:PORT/ht2/?tab=drive&truck=ZilR&mute" } }]
```

Адреси (`&mute` — завжди):

| | Вільна їзда | Кар'єра |
|---|---|---|
| HT2 | `/ht2/?tab=drive&truck=ZilR&mute` | `/ht2/?tab=career&mute` |
| HT1 | `/ht1/?tab=drive&level=COUNT&truck=1&ai=3&mute` | `/ht1/?tab=drive&career=1&mute` |

Інтерфейс перевіряти в ландшафті телефона — `resize_window` 812×375 (теж до навігації або з перезавантаженням).

Вже застрягло в меню — не чекати далі: `resize_window`, потім знову `navigate` на адресу гри.

## 5. Дочекатися готовності — короткими викликами
`javascript_tool` обривається через **45 с** — цикл не довший за ~35 с; не готово — повторити той самий виклик
(перший запуск на новому порту читає ресурси довше, `esc16.RES` HT2 — 57 МБ):

```js
// HT2
for (let i = 0; i < 70 && !window.ht2?.drive; i++) await new Promise(r => setTimeout(r, 500));
const d = window.ht2?.drive;
d ? { ready: true, truck: d.def?.carNode, ui: !!d.escArt, w: innerWidth, h: innerHeight } : { ready: false, w: innerWidth, h: innerHeight }
```

```js
// HT1
for (let i = 0; i < 70 && !window.ht?.dev; i++) await new Promise(r => setTimeout(r, 500));
window.ht?.dev ? (await ht.dev.ready(), ht.dev.info()) : 'ще вантажиться'
```

`ready: false` і `w`/`h` = 0 — крок 4 не виконано. `ready: false` зі слушним розміром двічі поспіль —
`read_console_messages` (`onlyErrors`) і `preview_logs` (нема файлів гри — не задано `HT_GAME_ROOT` у worktree).

## 6. Корисне після запуску
- HT2: `window.ht2.drive` (`d`), сцена — `d.world.scene`, камера — `d.camera`, машина — `d.truck`
  (`d.truck.visual` — модель). Перенести машину — скіл `ht2-teleport` (той самий код, лише `tabId` своєї
  вкладки). HT1 — `window.ht.dev` (скіл `verify-in-game`).
- Схована панель — `requestAnimationFrame` стоїть: числа — синхронними викликами (`ht.dev.run`, `d.update`), для
  знімка — `tabs_select` своєї вкладки на час знімка.
- Свій порт — **окреме походження**: localStorage й IndexedDB порожні, збережень користувача немає й зачепити їх
  не можна. Для кар'єри — нова гра.
- Код змінено — Vite сам перезавантажує лише вкладки свого сервера.

## 7. Прибрати
`resize_window` `preset: 'desktop'`, `tabs_close` своїх вкладок, `preview_stop` свого сервера,
`git checkout -- .claude/launch.json`.

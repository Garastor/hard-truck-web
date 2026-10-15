# План реструктуризації: рушій + ігри

**Стан:** виконано 2026-10-15 (гілка `refactor/structure`, кроки 1–7; журнал — [progress.md](progress.md)); 2026-10-16
з `engine/` винесено модулі однієї гри (формати другої гри → `games/ht2/formats`, `mergeStatic` → `games/ht2/world`,
фари першої гри `truckLights` → `games/ht1/render`). Відмінності
від плану: формат B3D лишився спільним (`Docs/formats/b3d.md`), формати другої гри — `Docs/ht2/formats.md`; доступ
до памʼяті процесу для телеметрії — `tools/re/procmem.py`; скрипти перенесення — `tools/refactor/`.

Мета: з шляху файлу одразу видно, чи це спільний рушій, перша гра чи друга, а нова гра (HT3, Rig'n'Roll…)
додається текою `games/<id>/` без правок чужого коду. Поведінка, адреси (`/ht1/`, `/ht2/`, `?tab=…`) і збереження
(`ht.*`, `ht2.*`) не змінюються.

## Що зараз заважає
- Перша гра не має своєї теки: її код розкиданий по `modes/drive.ts`, `ui/*`, `game/{career,track,raceProgress,
  movables,viewSettings}.ts`, `render/{cab2d,cab2dRain,headlights,wetReflections,roomVisibility,effects}.ts`,
  `assets/cab2d.ts`, а `main.ts` (957 рядків) — водночас оболонка вибору гри й увесь застосунок HT1.
- Спільне й «першогрове» лежать поруч у тих самих теках (`game/truckVehicle.ts` — ядро, `game/career.ts` — HT1).
- HT2 бере `modal` з `ui/careerUi.ts` (UI першої гри) — залежність між іграми.
- `games/ht2/` — 30 файлів однією купою (світ, машини, трафік, кар'єра, меню).
- Тести, нотатки реверсу, документи й інструменти розрізняються лише префіксом `ht2-` у назві.

## Цільова структура `web/src`
```
app/                 оболонка: вхід (main.ts — лише маршрут гри), вибір гри (select), реєстр ігор, PWA,
                     якість/FPS, devTools, імпорт файлів гри
engine/              спільний рушій — нічого не знає про конкретну гру
  formats/           парсери: b3d, rmp, txr, msk, plm, ini, way, tech, sexpr, sdte, fon, heightmap, ovl, binary
  assets/            джерела файлів (dev-сервер, IndexedDB), кеш
  render/            sceneBuilder, mergeStatic, glassRain, waterBuffer
  physics/           світ Rapier, колізії рівня
  vehicle/           truckVehicle, engine (двигун/коробка), trucks (модель), autopilot
  input/  audio/
  ui/                pixelFont, softUi, modal, mobile, navMap — віджети без логіки гри
games/
  ht1/               Дальнобойщики: app.ts (з main.ts), drive.ts (з modes/), career/, track, race, movables,
                     menu/ (menuScreens, menuLocale, careerUi), hud, cab2d (+ дощ на склі 2D), headlights,
                     wetReflections, roomVisibility, effects, viewSettings, files.ts
  ht2/               Дальнобойщики 2, за підтеками:
    world/           world, terrain, trees, weather, climate, signs, roads, worldMap
    vehicles/        trucks, trailer, dents, controls
    traffic/         traffic, truckers, police, mafia
    career/          career, careerMode, economy, market, upgrades
    ui/              menu, settings, viewer, music
    app.ts drive.ts race.ts files.ts
```
Кожна гра експортує з `games/<id>/index.ts` один обʼєкт `GameModule` (id, назва, набір файлів, `start(ctx)`);
`app/registry.ts` лише перелічує модулі — нова гра = нова тека + рядок у реєстрі.

### Що потрапляє в `engine/`, а що лишається в грі
`engine/` — це **механізми** (як читати файл, як намалювати сцену, як їде машина), а не **поведінка** гри (коли
йде дощ, як виглядає, які коефіцієнти). Модуль іде в `engine/` лише за двох умов: ним користуються щонайменше дві
гри, і відмінність між ними зводиться до параметрів.
- **Однаковий механізм, різні параметри** → `engine/` з профілем-опцією, параметри — у грі. Приклади: фізика
  вантажівки (`TruckSetup`), двигун і коробка (`EngineProfile`: у HT2 — свої криві газу й перемикання),
  керування (`InputProfile`), краплі на склі й двірники (обидві гри — маски `glass_*.msk`).
- **Різна поведінка** → кожна гра має своє. Дощ: у HT1 — струмені навколо камери (`RainNode`/`RainKey` моделі),
  туман і світло — константи; у HT2 — погода з `WEATHER.INI`, показник w, вітер, калюжі, блискавки. Тож
  `games/ht1/weather.ts` і `games/ht2/world/weather.ts` окремо, у спільному — лише краплі на склі. Так само фари
  (HT1 — власні відблиски `wetReflections`, HT2 — прожектори), меню, кар'єра, HUD.
- Спершу код живе в грі; у `engine/` переходить, коли **друга** гра потребує того самого (не «про запас»).
- Якщо у спільному модулі зʼявляється `if (гра === …)` або гілка лише для однієї гри — це сигнал розділити: в
  `engine/` лишається основа, гра передає свою частину параметром чи розширює її у своїй теці.
- У `engine/` немає ідентифікаторів ігор (`ht1`, `ht2`, назв файлів конкретної гри) — це теж перевіряє тест.

### Правила залежностей (перевіряє тест `test/architecture.test.ts`)
- `engine/*` не імпортує `games/*` і `app/*`.
- `games/ht1` і `games/ht2` не імпортують одна одну; спільне — лише через `engine/`.
- `app/*` імпортує ігри лише через `games/<id>/index.ts` (динамічно — код гри вантажиться після вибору).
- Псевдоніми шляхів `@engine/…`, `@ht1/…`, `@ht2/…` (tsconfig + vite) замість `../../..`.

## Поза `web/src`
| Зараз | Буде |
|---|---|
| `web/test/*.test.ts` (усе разом) | `web/test/engine/`, `web/test/ht1/`, `web/test/ht2/` |
| `re/notes/*.md`, `re/notes/ht2-*.md` | `re/notes/ht1/`, `re/notes/ht2/` (без префіксів) |
| `tools/re/{gq.py,telemetry.py,ht2/}` | `tools/re/` — спільне (gq.py, доступ до памʼяті), `tools/re/ht1/`, `tools/re/ht2/` |
| `Docs/01…08`, `gameplay.md`, `formats/` | `Docs/` — спільне (архітектура, інструменти, робочий процес, право), `Docs/ht1/` (аналіз, roadmap, gameplay, формати), `Docs/ht2/` (план, формати) |
| `Docs/progress.md` (обидві гри) | `Docs/ht1/progress.md`, `Docs/ht2/progress.md`, спільні зміни рушія — `Docs/progress.md` |

`CLAUDE.md`: таблиця «Дві гри» скорочується до трьох рядків-тек; скіли (`ht2-telemetry`, `verify-in-game`,
`step-done`) і агент `re-analyst` — нові шляхи.

## Порядок (кожен крок — окремий коміт, `tsc` + усі тести + збирання зелені, `git mv` — історія файлів зберігається)
1. **Каркас:** `GameModule`, псевдоніми шляхів, тест архітектури (спершу з переліком наявних порушень).
2. **Рушій:** перенести `formats`, `physics`, `input`, `audio`, спільні `render`/`vehicle`/`assets`/`ui` в
   `engine/`; `modal` — з `careerUi.ts` в `engine/ui/modal.ts`.
3. **Перша гра:** `modes/drive.ts`, HT1-частини `ui/`, `game/`, `render/`, `assets/cab2d` → `games/ht1/`;
   `main.ts` розділити на `app/main.ts` (оболонка) і `games/ht1/app.ts`.
4. **Друга гра:** підтеки `games/ht2/*`.
5. **Тести, re/notes, tools, Docs**, `CLAUDE.md`, скіли.
6. Перевірка: обидві гри в браузері (меню, їзда, кар'єра), мобільний вʼюпорт, збирання для GitHub Pages.

Обсяг: переважно механічне перенесення й правка імпортів, логіка не змінюється. Ризики: незакомічені правки інших
сесій у файлах, що переносяться (зараз — `ui/careerUi.ts`), — переносити після їхнього коміту; Vite під час
перенесень перезавантажує вкладку повністю (заїзд скидається, збереження ні).

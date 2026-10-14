# 02. Інструменти

Позначки: ⭐ — ключовий інструмент, ➕ — бажаний, 🔍 — довідковий/для дослідження.
Стан на жовтень 2026. Версії фіксуємо в `package.json` при старті Фази 0.

## 1. Напрацювання спільноти «Дальнобійників» (найцінніше)

| | Інструмент | Що дає | Посилання |
|-|-----------|--------|-----------|
| ⭐ | **reRNR / RNRFileFormats** | Специфікації форматів у **Kaitai Struct** (`.ksy`): b3d, res/rmp, txr, msk, plm (HT1+HT2). Kaitai компілюється в **JavaScript/TypeScript** → парсери можна напряму використати у веб-порті. MIT | https://github.com/reRNR/RNRFileFormats |
| ⭐ | **AlexKimov / HardTruck-RignRoll-file-formats** | Шаблони 010 Editor (`b3D.bt`, `RES.bt`, `TXR.bt`, `MSK.bt`, `PLM.bt`), скрипти розпакування, вікі з описом форматів (рос.). MIT, архівований | https://github.com/AlexKimov/HardTruck-RignRoll-file-formats |
| ⭐ | Вікі формату b3D (HT2) | Опис блоків 0–40, маркерів, ієрархії | https://github.com/AlexKimov/HT2-RnR-tools/wiki/b3D-File-Format-Rus |
| ➕ | **reRNR / RNRNoesisPlugins** | Плагіни Noesis: перегляд/експорт txr, msk, розпакування res/rmp | https://github.com/reRNR/RNRNoesisPlugins |
| ➕ | reRNR / RNRDocs | Документація (сайт) | https://rernr.github.io/RNRDocs |
| ➕ | **aleko2144 / Hard-Truck-1-2-Blender-plugins** | Імпорт/експорт b3d у Blender (2.79, MIT). Як еталон логіки читання блоків і для ручного огляду сцен | https://github.com/aleko2144/Hard-Truck-1-2-Blender-plugins |
| ➕ | **Duude92 / B3DBlockEditor** | Редактор дерева блоків b3d (HT1/2) — зручно дивитися ієрархію | https://github.com/Duude92/B3DBlockEditor |
| 🔍 | KudryavtsevDmitry / ht2-rev | Реконструкція коду HT2 (дизасемблер + C++) — підказки щодо логіки рушія (рушій той самий родовід) | https://github.com/KudryavtsevDmitry/ht2-rev |
| 🔍 | REDPOWAR / D2GI | Обгортка DX7→DX9 для HT2 — розуміння рендер-конвеєра | https://github.com/REDPOWAR/D2GI |
| 🔍 | ModDB: Hard Truck Series Engine | Інструменти, моди, редактор RES | https://www.moddb.com/engines/hard-truck-series-engine |

**Для HT2 (King of the Road)** — повний перелік з ліцензіями в [ht2/plan.md §3](ht2/plan.md#3-інструменти-спільноти-для-ht2):
розшифрування `SDTE` (`*.sch`, `GAME.CNF`) — `KeyGenerator.1sc`/`decodeSCH.1sc` з AlexKimov (MIT);
WAY — [VldmrInt/HT2-WAY-Tool](https://github.com/VldmrInt/HT2-WAY-Tool) (MIT); TECH/RAW — `.bt` AlexKimov і `.ksy` reRNR.

## 2. Дослідження бінарних форматів і коду

| | Інструмент | Для чого |
|-|-----------|----------|
| ⭐ | **Kaitai Struct** (compiler + Web IDE https://ide.kaitai.io) | Візуальний розбір файлів за `.ksy`, генерація парсерів у JS/TS/Python |
| ⭐ | **ImHex** (безкоштовний) або 010 Editor (платний) | Hex-редактор з мовою шаблонів; 010 — щоб використати готові `.bt` від AlexKimov |
| ⭐ | **Python 3.13** (вже встановлено) | Швидкі зонди форматів (`tools/probe/`), пакетна конвертація |
| ➕ | **Noesis** (Rich Whitehouse) | Перегляд моделей/текстур з плагінами reRNR |
| ➕ | **Blender 4.x** | Огляд/перевірка конвертованих glTF; за потреби — Blender 2.79 для старого плагіна |
| ⭐ | **Ghidra 12.x** + **pyghidra-mcp** | Реверс `HTruck.exe`: Claude Code сам декомпілює функції фізики/логіки. Потрібна JDK 21 (зараз стоїть Java 8). Деталі в [07](07-reverse-engineering.md) |
| ⭐ | **Cheat Engine** (встановлено) / **x32dbg** / **Frida** | Динамічний аналіз: структура авто в памʼяті, телеметрія еталонних заїздів |
| ⭐ | **dgVoodoo2** | Запуск оригіналу на Windows 11 (DX5/6 → DX11) для еталонних скріншотів/відео. Лог `error.log` показує, що без обгортки гра падає |
| ➕ | OBS Studio | Запис еталонного геймплею оригіналу для порівняння |

## 3. Веб-рушій (runtime)

| | Інструмент | Роль | Чому |
|-|-----------|------|------|
| ⭐ | **TypeScript** | Мова | Типи для бінарних структур, рефакторинг з Claude Code |
| ⭐ | **Vite** | Збірка/dev-сервер | Швидкий HMR, ESM, плагін PWA |
| ⭐ | **Three.js** | 3D-рендер (WebGL2, опційно WebGPU) | Найбільша екосистема, легкий, стабільний на мобільних; glTF/KTX2 з коробки |
| ⭐ | **Rapier** (`@dimforge/rapier3d-compat`, WASM) | Фізика, колізії, `DynamicRayCastVehicleController` | Швидкий, детермінований, підтримує вантажівки з raycast-колесами |
| ➕ | cannon-es | Альтернатива Rapier (чистий JS, `RaycastVehicle`) | Простіше дебажити, повільніше |
| ⭐ | **Web Audio API** (+ опційно Howler.js) | Звук двигуна (пітч від обертів), 3D-звуки | Нативно, низька затримка |
| ⭐ | Pointer Events + **власні сенсорні контроли** | Кермо/педалі/КПП | Повний контроль над UX |
| ➕ | DeviceOrientation API | Кермування нахилом телефону | Опція в налаштуваннях |
| ➕ | Gamepad API | Геймпад (телефон + Bluetooth-контролер, ПК) | Безкоштовно «з коробки» |
| ➕ | Screen Orientation API + Fullscreen API | Ландшафтний повноекранний режим | Обовʼязково для мобільних |
| ➕ | **lil-gui**, stats.js | Debug-панель, FPS | Тюнінг фізики/рендеру на льоту |
| 🔍 | Babylon.js | Альтернатива Three.js | Більше «з коробки», але важчий бандл |

## 4. Конвеєр ресурсів (offline, Node/Python CLI у `tools/`)

| | Інструмент | Що робить |
|-|-----------|-----------|
| ⭐ | **Node.js 22 LTS** — **НЕ встановлено** → встановити | Запуск Vite, CLI-конвертерів |
| ⭐ | **kaitai-struct-compiler** | `.ksy` → TS/JS парсери (+ Python для зондів) |
| ⭐ | **glTF-Transform** (`@gltf-transform/cli`) | Збірка/оптимізація glTF: dedup, weld, meshopt, KTX2 |
| ⭐ | **ffmpeg 7.1** (вже встановлено) | WAV → Opus/AAC; `HTruck.avi` (Cinepak) → MP4 H.264 |
| ➕ | **KTX-Software** (`toktx`) / Basis Universal | Стиснуті GPU-текстури KTX2 (менше памʼяті на телефоні) |
| ➕ | sharp (Node) або Pillow (Python) | TXR/MSK → PNG/WebP |
| ➕ | meshoptimizer | Стиснення геометрії |

## 5. Мобільність, PWA, зберігання

| | Інструмент | Роль |
|-|-----------|------|
| ⭐ | **vite-plugin-pwa** (Workbox) | Service Worker, офлайн-режим, «встановити на головний екран» |
| ⭐ | **OPFS / IndexedDB** (+ `idb-keyval`) | Кешування конвертованих ресурсів та збережень на пристрої |
| ⭐ | **fflate** | Розпакування ZIP у браузері (якщо гравець завантажує свій архів гри) |
| ➕ | Web Workers + Comlink | Парсинг/конвертація ресурсів поза головним потоком |
| ➕ | Capacitor | (Опційно, пізніше) обгортка PWA в нативний APK/IPA |

## 6. Тестування та якість

| | Інструмент | Для чого |
|-|-----------|----------|
| ⭐ | **Vitest** | Юніт-тести парсерів (golden-тести на реальних файлах гри) |
| ⭐ | **Playwright** | E2E + емуляція мобільних (iPhone/Pixel), скріншот-регресії сцени |
| ⭐ | **Вбудований браузер Claude Code** (`preview_start`, `resize_window mobile`) | Claude сам відкриває dev-сервер, дивиться скріншоти, консоль, мобільний вʼюпорт |
| ➕ | Chrome DevTools Remote Debugging / Safari Web Inspector | Відлагодження на реальному Android / iPhone |
| ➕ | Spector.js | Аналіз WebGL-кадрів (draw calls, текстури) |
| ➕ | ESLint + Prettier | Стиль коду |
| ➕ | Lighthouse | Перевірка PWA та продуктивності |

## 7. Інфраструктура

| | Інструмент | Роль |
|-|-----------|------|
| ⭐ | **Git** (є) + GitHub (**приватний** репозиторій) | Версіонування коду (без ресурсів гри!) |
| ➕ | `gh` CLI — **не встановлено** | PR, issues з Claude Code |
| ➕ | GitHub Actions | CI: lint + tests + build |
| ➕ | Cloudflare Pages / Netlify / GitHub Pages | Хостинг **лише коду** (ресурси — від гравця, див. 06) |

## 8. Встановити перед Фазою 0

```bash
winget install OpenJS.NodeJS.LTS
```
```bash
winget install GitHub.cli
```
```bash
winget install WerWolv.ImHex
```
```bash
winget install EclipseAdoptium.Temurin.21.JDK
```
Окремо вручну: Ghidra + pyghidra-mcp (див. [07](07-reverse-engineering.md#3-як-claude-code-працюватиме-з-exe)), dgVoodoo2 (для запуску оригіналу), Noesis (опційно), Blender 4.x (опційно).

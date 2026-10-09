# Hard Truck Web

Порт гри *Hard Truck / Дальнобойщики* (SoftLab-NSK, 1998) у браузер. Основна платформа — **мобільні** (touch, ландшафт, PWA).
Мова спілкування та документації — **українська**.

## Ключові документи
- План і статус: `Docs/04-roadmap.md` (оновлювати чекбокси), журнал: `Docs/progress.md`
- Формати: `Docs/01-analysis.md`, `Docs/formats/b3d.md`; правила оригіналу: `Docs/gameplay.md`
- Реверс: `Docs/07-reverse-engineering.md`, нотатки `re/notes/*.md`
- Гра на телефоні: `Docs/play-on-phone.md`

## Підхід
Реімплементація рушія (TypeScript + Vite + Three.js + Rapier), яка читає оригінальні ресурси. Не емуляція `HTruck.exe`.
Порт використовує «апаратний» набір локацій: `*2.B3D` + `*3.RMP`.

## Розташування
- `Game/Hard Truck/` — оригінальна гра. **Лише читати. Ніколи не змінювати, не комітити, не публікувати.**
- `web/` — порт: `src/formats` (парсери), `src/render` (SceneAssembler), `src/game` (вантажівки, траса, автопілот),
  `src/modes/drive.ts` (їзда/гонка), `src/assets` (джерела файлів: dev-сервер або IndexedDB), `test/` (golden-тести)
- `tools/probe/` — Python-зонди форматів; `tools/re/` — Ghidra: `gq.py` (CLI-запити), Watcom cspec, setup
- `re/` — проєкт Ghidra і декомпіляція (не комітити, крім `re/notes/`)

## Команди
- `npm run dev --prefix web` — dev-сервер (віддає файли гри за `/game/...`); превʼю: `.claude/launch.json` → `web`
- `npm test --prefix web` — golden-тести парсерів на реальних файлах; `npx tsc --noEmit` у `web/`
- `.venv/Scripts/python -I tools/re/gq.py <cmd>` — запити до Ghidra (див. `tools/re/README.md`)
- Node може бути відсутній у PATH старої оболонки: `C:/Program Files/nodejs`

## Налагодження в браузері (dev)
`window.ht` — `scene`, `camera`, `built`, `level`, `drive`. `drive.simulate(n)` — n кроків фізики без rAF
(панель браузера Claude Code часто прихована → requestAnimationFrame стоїть). `drive.toggleAutopilot(true)`.

## Правила
- Парсери форматів покриваються golden-тестами на реальних файлах (читати до останнього байта).
- Параметри (вантажівки, матеріали, події) — з файлів гри, не хардкод; невідоме — позначати як гіпотезу.
- Кожну UI/рендер-фічу перевіряти у мобільному вʼюпорті (preview + `resize_window`).
- Ресурси гри не потрапляють у git (`Game/`, `*.zip`, `*.avi`, `*.b3d`, `*.rmp`, `*.res`, `*.exe` — у `.gitignore`).
- Не копіювати дизасембльований код з `HTruck.exe` — лише власна реалізація поведінки.
- Комітити після кожного завершеного кроку; не пушити й не публікувати без запиту.

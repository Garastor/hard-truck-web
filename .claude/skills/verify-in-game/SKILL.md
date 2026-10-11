---
name: verify-in-game
description: Перевірити зміну в грі в браузері Claude (вбудована панель) — окрема вкладка, ht.dev, знімок, мобільний вʼюпорт, прибирання. Використовувати після кожної зміни рендеру, фізики, інтерфейсу чи ігрової логіки Hard Truck Web.
---

# Перевірка в грі

Dev-сервер: `preview_start` з назвою `web` (`.claude/launch.json`), адреса `http://localhost:5173`.

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

## Корисне
- `ht.dev.info()` — траса, кімната, позиція, швидкість, камера, погода, режим відблисків.
- `ht.drive.roadBelow(x, y, z)`, `ht.drive.glossAt(x, y, z)` — висота й блиск дороги.
- Модулі можна імпортувати в сторінці: `await import('/src/game/collision.ts')`.
- Великий результат `javascript_tool` (> ~100 КБ) не повертати — зводити до коротких рядків.

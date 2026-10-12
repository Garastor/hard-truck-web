# Формати Дальнобойщиків 2 (King of the Road)

Парсери — `web/src/formats/`, golden-тести — `web/test/ht2.test.ts` (усі файли гри з `Game/Hard Truck 2`).

| Формат | Парсер | Стан |
|--------|--------|------|
| B3D | `b3d.ts` (спільний з HT1) | 45/45 файлів до останнього байта |
| RES | `rmp.ts` (спільний) | 141/141; імена текстур можуть повторюватися з тими самими даними (`ENV/ap.res`) |
| TXR | `txr.ts` | 16 біт 565/4444; **PFRM з нульовими масками** — карти нерівностей `bump_*.txr` (du/dv зі знаком) → `bump: true` |
| SCH / CNF | `sdte.ts` + `sexpr.ts` | шифр SDTE розшифровано, S-вирази в cp1251 |
| WAY | `way.ts` | 41/41; у RSEG є ще чанк `RTEN` (рядок «W005») |
| TECH | `tech.ts` | 43 записи × 2416 байтів; ключові поля звірено з HT1 |
| RAW | `heightmap.ts` | 257×257 u16 (обидва байти однакові) |
| OVL | `ovl.ts` | `CLUSTER імʼя` … `END` |

## SDTE (`*.sch`, `GAME.CNF`)
`"SDTE"` + дані, XOR з молодшим байтом адитивного генератора Фібоначчі (55 слів, `t[c] -= t[c+31]`), початковий
стан — 55 констант (див. `sdte.ts`). Джерело — AlexKimov/HardTruck-RignRoll-file-formats (`KeyGenerator.1sc`, MIT).
Розшифровано всі 10 файлів; `rnrnfo.scq` — інший шифр (не розібрано).

Вміст (S-вирази, `;` — коментар, `( A . "текст" )` — пара):
- `ENV/GAME.CNF` — `playertypes` (`live 1 "ZilR" 1`, `aitruck 50`, `police 15`, `mafia 8`, `dumb 70`, `ghost 25`),
  `startposition x y z`, кількості `forsale`, `forhire`, `missions`, `fuel`, `semitrailers`, `containers`, `parkings`;
  `MENV`/`MTR` — `scenario races|trial`.
- `merchandise.sch` — товари: `(BREAD CRATE 25 0.1 (25 70 0.85 (trucks)) 0.85 71 "Хлеб")`.
- `evehicles.sch` — транспорт: `(vehicle FIAT_1 "Fiat" 0 car dumb 32000 408 ())`.
- `etrashboxes.sch` — припарковані машини; `names.sch` — імена (поліція, мафія, далекобійники);
  `restable.sch` — покращення й ціни; `vd.sch` — назви машин; `Ms.sch` — повідомлення гри.

## TECH (`vehicle.tech`)
Заголовок: `u32 n, char[n] ".\truck2.tch"`, `u32 мітка`, `u32 розмір запису (2416)`, `u32 кількість (43)`, 7×u32
межі груп. Записи — за `hard_truck_2_tech.ksy` (reRNR, MIT). Уточнення:
- кількість передач — `u32` на зсуві **+36** після `fuelTimeEndurance` (разом з нейтраллю): Zil 6 → 5 передач уперед;
  масив `gear_trans_coeff[14]` далі заповнений спадною послідовністю (заповнювач); `[0]` — нейтраль (0).
- `tach_with_max_power` у файлі — оберти за секунду (×60 → об/хв), `tangViewer` — радіани.
- Групи за `tch`: `cars` (0–17), `lorries` (18–25, вантажівки з кузовом, суфікс `R`), `tractors` (26–38),
  `trailers` (39–42, `trailerType` 1 модуль, 2 платформа, 3 цистерна).

## WAY (`ENV/*.way`)
Чанки `тег + u32 розмір`, вирівнювання 4. `WTWR{MNAM, GDAT{GROM{RNAM, RNOD{NNAM, POSN 3×f64, FLAG, [ORTN 12×f64]},
RSEG{ATTR (u32, f64, u32), [RTEN], WDTH 2×f64, VDAT u32 n + n×3 f64}}}}`.
Специфікація — VldmrInt/HT2-WAY-Tool (`HT2_WAY_FORMAT.md`, MIT); значення ATTR — гіпотези.

## Моделі вантажівок (`COMMON/TRUCKS.B3D`)
Збірні: на верхньому рівні — простори (тип 24) `<Префікс>Wheel0Space`, `…BoothSpace`, `…MirrorLSpace`, бампери,
двигуни; групи (тип 5) `<Префікс>` з посиланнями (тип 18) на деталі й колесами `<Префікс>wheel0..N`, тінь
`<Префікс>Shadow`, фари `…BFaraL/R`, колізія `hit_<Префікс>`. Префікс — поле `prefix` у TECH.

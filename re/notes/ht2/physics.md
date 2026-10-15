# HT2: фізика вантажівки в king.exe — стан реверсу

Мета: зʼясувати, чи фізика Дальнобойщиків 2 — та сама, що в першій грі (порт зараз їздить на моделі HT1 з
параметрами HT2: `engine/vehicle/truckVehicle.ts` + `games/ht2/vehicles/controls.ts`), і, якщо ні, відтворити її
окремо в `games/ht2/vehicles/`. Для порівняння: у HT1 з `HTruck.exe` відновлено лише двигун і коробку
(re/notes/ht1/physics.md); шини, підвіска й рух кузова в обох іграх — Rapier, підібраний під телеметрію.

## Висновок (2026-10-16): модель HT2 інша, не лише параметри
Той самий клас `_Car_V` / `_Vehicle` (спільне походження коду), але суттєво перероблений:

| | HT1 (`HTruck.exe`) | HT2 (`king.exe`) |
|---|---|---|
| Колеса | рівно 4, вузли `wheel_node_fl/fr/bl/br` | довільно (`MAX_W`; ЗіЛ — 6): `driving_wheels`, `touching_road_wheels`, `steering_wheels` (по 8 прапорців) |
| Опір повітря | немає | `air_resist_coeff`, `air_side_resist_coeff`, `air_press_coeff` |
| Тіло | — | `mass`, `bounce_coeff`, `friction_coeff`, тензор інерції `iI` (рядок налагодження) |
| Зіткнення | `collision_coeff` (truck.ini) | `rubber_collision_coeff`, `slide_collision_coeff`, `CollisionCenter`/`Radius`, `CollisionPlane%d`, `AddColPnts%d` |
| Підвіска | ks/cs/hmin/hmax (у TCH закоментовано) | `suspension` — 8 чисел на колесо |
| Причіп | — | сідло `lowSaddle`/`topSaddle`/`shiftSaddle`, `TowHook`, `Coupler`, `getSemiTrailerSaddleLoad` |
| Вантаж | — | `cargo_and_body_pick_load`, `center_of_cargo_bottom`, `body_mass`, `body_height`, `body_square` |
| Крок | `_Car_V:run2` (один) | `_Car_V::run` → `run1` (#1–#4) і `run2` (#1–#7), системи пошкоджень і покращень (`MAX_CARV_TECHSYS`, `MAX_CARV_DAMAGE`) |

Отже, HT2 потрібна власна модель руху, відновлена з king.exe (у рушії лишаються Rapier і колізії рівня).

## Якорі в king.exe (Ghidra `re/king`, декомпіляція `re/decomp_king` — локально)
| Адреса | Що |
|---|---|
| 0x508300 | читання `vehicle.tech` (текстові секції LORRIES / TRACTORS / SEMI-TRAILERS / TRAILERS / HELICOPTERS): імена полів → зсуви запису (див. нижче) |
| 0x4ebd00 | конструктор `_Car_V` (перевірка кількості коліс `MAX_W`) |
| 0x4d6510 | `_Car_V::run` — кадр машини: гравець (прапорець 4 стану гравця) → 0x4feee0; інакше — повний крок |
| 0x4fdc80 | `_Car_V::run1` (#1–#4): викликає 0x501930 (`check_damage`), 0x500850, 0x4f0450, 0x4f0ce0, 0x4f0090, 0x4f2490, `run2`, далі 0x505530, 0x4fca10, 0x4f6b70 |
| 0x4f35f0 | `_Car_V:run2` — **обертання коліс**: колесо, що котиться, — ω = (v · n)/r (поздовжня швидкість у точці колеса / радіус); ведуче з увімкненою передачею — ω = оберти двигуна × головна / передатне ([+0x1c84], [+0x1c44 + 4·передача]); кути нормуються 0x4e41d9 |
| 0x4f3000 | 199 рядків — після run2 (трансмісія/двигун? — не розібрано) |
| 0x4fca10 | 667 рядків — найбільша частина run1 (імовірно сили коліс і підвіска — не розібрано) |
| 0x505530 | 477 рядків — (зіткнення? — не розібрано) |
| 0x4fb470 | `_Car_V::form_position1` |
| 0x54a380 | `_Vehicle::make_new_Pos` — інтегрування (вхід `wheels_alf[i]` по 2 і 4 колеса) |
| 0x4eec80 | `_Car_V::getSemiTrailerSaddleLoad` |
| 0x501930 | `_Car_V::check_damage` |
| 0x4d1360 | `_Vehicle::run` (гілки car / lorry / tractor) |

Поля обʼєкта (з run2): кількість коліс [+0xdd4]; на колесо i — ω [+0xebc + 4i], радіус [+0xebc + 4i + 0xcb8],
прапорець «ведуче» [+0x19a4 + 2i] (short), ознака «є передача» [+0xebc + 4i + 0xcf8]; поточна передача [+0x1c1c],
оберти двигуна [+0x1c84], передатні числа [+0x1c44 + 4·передача], головна передача [+0x1c88].

## Поля vehicle.tech (0x508300; запис — масив float pfVar, зсуви — індекси float від вказівника запису)
`maxrotmomentum` (тип. 500), `breakpower` (тип. 6000), `rwheel`/`rwheel1` (0,3), `front/rear_wheel_thickness`
(0,2/0,4), `air_press_coeff` (0,3), `air_resist_coeff` (0,3), `air_side_resist_coeff` (0,8), `tach_with_max_power`
(1200), `rear_axle_coeff` (5), `reverse_trans_coeff` (−4), `gear_trans_coeff%d`, `fuelTimeEndurance`,
`kilometrage` (50), `fuelConsumption`, `tangViewer` (−0,125), `suspension` (8 чисел, тип. 0,3), `rubber_collision_coeff`
і `slide_collision_coeff` (0,5), `driving_wheels`, `touching_road_wheels`, `steering_wheels` (по 8),
`CenterMassInB3D` (обовʼязковий), `CollisionCenter`, `CollisionRadius` (1), `horse_power` (150), `price` (10000),
`glowwing`, сідло й зчіпка, `Corner_Mark_W%d`, `Corner_Mark_%d`, `AddColPnts%d`, `cargo_and_body_pick_load`,
`center_of_cargo_bottom`, `body_mass` (1000), `body_height` (2), `body_square` (10), `CollisionPlane%d`,
камера/дим/фари/кабіна, `trailer_type` (platform…). У дужках — значення за замовчуванням з king.exe.

## Далі
1. Розібрати 0x4fca10 (сили коліс і підвіска), 0x4f3000, 0x505530, `make_new_Pos` (0x54a380) — формули без
   копіювання коду, записати сюди.
2. Звірити з телеметрією (`tools/re/ht2`, re/notes/ht2/telemetry.md): прискорення, вибіг, гальмування, крен.
3. Модель HT2 у `games/ht2/vehicles/` (тіло Rapier, власні сили коліс, підвіски й повітря — як у king.exe);
   `engine/vehicle/truckVehicle.ts` лишається моделлю першої гри (або основою, якщо частина збіжиться).

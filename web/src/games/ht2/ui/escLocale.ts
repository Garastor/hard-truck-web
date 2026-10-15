/**
 * Українські написи на графіці інтерфейсу `esc16.RES`. Кнопки `m_16\<імʼя>_<стан>.txr` — шматок фону панелі під
 * кнопкою з російським написом поверх (перевірено: поза написом кнопка збігається з фоном у тій самій точці);
 * стани відрізняються лише кольором напису. Тому старий напис з тінню замінюється фоном панелі під кнопкою (без
 * фону — заповненням по стовпчиках), а новий пишеться кольором напису цього стану, виміряним на картинці.
 * Підписи на фонах — заповнення по стовпчиках між рядками над і під написом, поверх — новий підпис.
 */

/** Напис кнопки українською (ключ — імʼя без стану й теки, нижній регістр). */
export const BUTTON_UK: Record<string, string> = {
  savg: 'ЗБЕРЕГТИ ГРУ',
  loadg: 'ЗАВАНТАЖИТИ ГРУ',
  restart: 'ПОЧАТИ СПОЧАТКУ',
  control: 'КЕРУВАННЯ',
  sound: 'ЗВУК',
  main: 'ГОЛОВНЕ МЕНЮ',
  exitsys: 'ВИХІД',
  exsave: 'ЗБЕРЕГТИ',
  exnsave: 'НЕ ЗБЕРІГАТИ',
  excanc: 'СКАСУВАТИ',
  // СТО й заправка («ОК» — так само українською, лишається).
  servcanc: 'СКАСУВАТИ',
  gascanc: 'СКАСУВАТИ',
  // Підменю Esc «Звук» і «Керування».
  canc: 'СКАСУВАТИ',
  // Рація (F5): фрази гравця — по центру кнопки 258×44, довгі — у два рядки.
  f5p_ask1: '– НАВІЩО ШТРАФ, КОМАНДИРЕ,\nМОЖЕ, ДОМОВИМОСЯ?',
  f5p_ask2: '– ПРИКРИЙТЕ ЗАМОВЛЕННЯ ВІД БАНДИТІВ.',
  f5p_ask3: '– ЗАТРИМАЙТЕ КОНКУРЕНТА.',
  f5p_ask4: '– ДО ПОБАЧЕННЯ.',
  f5m_ask1: '– МЕНІ НЕ ПОТРІБНІ НЕПРИЄМНОСТІ.',
  f5m_ask2: '– ПОТРУСІТЬ МОГО КОНКУРЕНТА.',
  f5m_ask3: '– ХОЧУ ЗАМОВИТИ МАШИНУ.',
  f5m_ask4: '– ДО ПОБАЧЕННЯ.',
  f5o_ask1: '– НЕ ЖЕНИ.',
  f5o_ask2: '– СКИНЬ ВАНТАЖ.',
  f5o_ask3: '– ДО ПОБАЧЕННЯ.',
  f5n_ask1: '– ДОПОМОЖИ З РЕМОНТОМ МАШИНИ.',
  f5n_ask2: '– ХОЧУ ЗАМОВИТИ МАШИНУ.',
  f5n_ask3: '– ДО ПОБАЧЕННЯ.',
  f5p_ok: '– ДОМОВИЛИСЯ.',
  f5m_ok: '– ДОМОВИЛИСЯ.',
  f5o_ok: '– ДОМОВИЛИСЯ.',
  f5n_ok: '– ДОМОВИЛИСЯ.',
  f5p_canc: '– ЗАБУДЬ ПРО ЦЕ.',
  f5m_canc: '– ЗАБУДЬ ПРО ЦЕ.',
  f5o_canc: '– ЗАБУДЬ ПРО ЦЕ.',
  f5n_canc: '– ЗАБУДЬ ПРО ЦЕ.',
};

/** Кнопки з написом по центру (фрази рації): решта — ліворуч, як у меню. */
const CENTERED = (base: string) => base.startsWith('f5') && !base.startsWith('f5tr');

/**
 * Групи кнопок (одне вікно): у групі літери однакової ширини — стиск за найдовшим написом групи, а не кожен напис
 * окремо (на прохання користувача).
 */
const GROUPS: { keys: string[]; width: number }[] = [
  // Меню Esc: кнопки 150 px, відступ зліва до 10 і справа 4.
  { keys: ['savg', 'loadg', 'restart', 'control', 'sound', 'main', 'exitsys', 'exsave', 'exnsave', 'excanc'], width: 136 },
  { keys: ['servcanc'], width: 118 },
  { keys: ['gascanc'], width: 72 },
  { keys: ['canc'], width: 72 },
  // Фрази рації — усі однією шириною літер (кнопки 258 px, поля по 10).
  {
    keys: ['p', 'm', 'o', 'n'].flatMap((who) => ['ask1', 'ask2', 'ask3', 'ask4', 'ok', 'canc'].map((k) => `f5${who}_${k}`)),
    width: 238,
  },
];

const groupScale = new Map<string, number>();

/** Стиск по горизонталі для групи кнопки: щоб найдовший напис групи вмістився. */
function scaleFor(base: string): number {
  const group = GROUPS.find((g) => g.keys.includes(base)) ?? { keys: [base], width: 136 };
  const id = group.keys.join(',');
  if (!groupScale.has(id)) {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `bold ${Math.round(CAP_FOR(group.keys[0]) / 0.72)}px ${FONT}`;
    const widest = Math.max(...group.keys.flatMap((b) => (BUTTON_UK[b] ?? '').split('\n')).map((t) => ctx.measureText(t).width));
    groupScale.set(id, Math.min(1, group.width / Math.max(1, widest)));
  }
  return groupScale.get(id)!;
}

/**
 * Підпис на фоні вікна: що замалювати (старий напис з тінню), новий текст, прив'язка (x і базова лінія), висота
 * великих літер. Колір без явного — виміряний на старому написі (найсвітліші пікселі). group — підписи з однаковою
 * шириною літер (стиск за найдовшим у групі); spacing — розрідження літер заголовків («С Е Р В И С»).
 */
interface Label {
  erase: [number, number, number, number];
  text: string;
  x: number;
  base: number;
  align: 'left' | 'right' | 'center';
  cap: number;
  maxW: number;
  group?: string;
  color?: string;
  spacing?: number;
  /**
   * Як прибрати старий напис: типово — заповнення по стовпчиках; `ink` — лише пікселі жовтого тексту й контуру
   * навколо (картки відповідей рації на фото), заповнення від сусідів.
   */
  mode?: 'ink';
}

/**
 * Підпис у клітинці таблиці (СТО, склад, ринок, заправка): верх літер top, висота 11, тінь — до top + 12; нижня лінія
 * клітинки СТО — top + 14, тож опора заповнення — рядок top + 13 (з лінією були світлі смуги). Виміряно: текст (165, 205, 174) з темною тінню.
 */
function cell(x0: number, x1: number, top: number, text: string, align: 'left' | 'right' | 'center', group: string): Label {
  const x = align === 'right' ? x1 - 3 : align === 'left' ? x0 + 4 : (x0 + x1) / 2;
  return { erase: [x0, top - 2, x1, top + 12], text, x, base: top + 11, align, cap: 11, maxW: x1 - x0 - 6, group };
}

/** Стовпчик клітинок з кроком step. */
function column(x0: number, x1: number, top: number, step: number, texts: string[], align: 'left' | 'right', group: string): Label[] {
  return texts.map((t, i) => cell(x0, x1, top + step * i, t, align, group));
}

/** Заголовок вікна по центру. */
function title(erase: [number, number, number, number], text: string, x: number, base: number, cap: number, spacing = 0): Label {
  return { erase, text, x, base, align: 'center', cap, maxW: erase[2] - erase[0] + 30, spacing };
}

/** Заголовок панелей Esc (той самий на `BackEscMain`, `BackEscSnd`, `BackEscCtrl`). */
const ESC_TITLE: Label[] = [
  { erase: [26, 394, 148, 410], text: 'ПРОБЛЕМИ', x: 87, base: 409, align: 'center', cap: 14, maxW: 150, group: 'esc', color: 'rgb(205,207,206)' },
  { erase: [48, 417, 126, 433], text: 'В ДОРОЗІ', x: 87, base: 432, align: 'center', cap: 14, maxW: 150, group: 'esc', color: 'rgb(205,207,206)' },
];

/** Підпис повзунка підменю Esc по центру (x ≈ 91), верх літер top; рядків — скільки в тексті (\n), крок 15. */
function escLabel(top: number, text: string): Label[] {
  return text.split('\n').map((line, i) => ({ erase: [24, top + i * 15 - 2, 160, top + i * 15 + 12], text: line, x: 91, base: top + i * 15 + 11, align: 'center', cap: 11, maxW: 132, group: 'escsub' }) as Label);
}

/**
 * Підпис за виміряною рамкою старого тексту [x0 … x1], верх літер top: замальовується рамка з тінню, новий —
 * за вирівнюванням (ліворуч від x0, праворуч до x1, по центру); місце — maxW (типово ширина старого + запас).
 */
function at(x0: number, top: number, x1: number, text: string, align: 'left' | 'right' | 'center', group: string, maxW = x1 - x0 + 12, cap = 11): Label {
  const x = align === 'left' ? x0 : align === 'right' ? x1 : (x0 + x1) / 2;
  // Згори — 2 рядки запасу: лінія клітинки буває за 4 рядки над літерами, і заповнення бралося б від неї (світла пляма).
  return { erase: [x0 - 3, top - 2, x1 + 4, top + cap + 3], text, x, base: top + cap, align, cap, maxW, group };
}

/** Картка відповіді рації 129×69: жовтий текст по лівому краю (x 8), рядки через 17; стирання — «чорнилом». */
function answer(lines: string[], top: number, erase: [number, number, number, number]): Label[] {
  return lines.map((t, i) => ({ erase, text: t, x: 6, base: top + 14 + i * 18, align: 'left', cap: 14, maxW: 118, group: 'f5ans', color: 'rgb(255,255,0)', mode: 'ink' }) as Label);
}

/** Пігулки «ПОШУК» (99×36) і кругла «ПРИЙОМ» (84×84) — темний текст на світлому, у кожному стані. */
const RADIO_BUTTONS: Record<string, Label[]> = Object.fromEntries(
  ['p', 'a', 'ap'].flatMap((st) => [
    [`m_16/f5search_${st}.txr`, [{ erase: [14, 9, 84, 27], text: 'ПОШУК', x: 49, base: 25, align: 'center', cap: 13, maxW: 70, group: 'f5btn', color: 'rgb(20,24,28)', spacing: 2 } as Label]],
    [`m_16/f5talk_${st}.txr`, [{ erase: [12, 30, 72, 54], text: 'ПРИЙОМ', x: 42, base: 51, align: 'center', cap: 16, maxW: 62, group: 'f5btn2', color: 'rgb(20,24,28)' } as Label]],
  ]),
);

/** Рація: корпус «РАЦІЯ» / «В ЕФІРІ», кнопки, картки відповідей (виміряно на картинках esc16.RES). */
const RADIO_UK: Record<string, Label[]> = {
  ...RADIO_BUTTONS,
  'm16/backf5cbradio.msk': [],
  'm_16/backf5cbradio.msk': [
    { erase: [56, 28, 196, 60], text: 'РАЦІЯ', x: 125, base: 56, align: 'center', cap: 24, maxW: 140, color: 'rgb(20,40,60)' },
    { erase: [36, 84, 92, 95], text: 'В ЕФІРІ', x: 38, base: 93, align: 'left', cap: 9, maxW: 60, color: 'rgb(30,40,28)' },
  ],
  'm_16/f5m_ans_cost.txr': answer(['– ЦЕ КОШТУВАТИМЕ'], 19, [0, 15, 128, 42]),
  'm_16/f5n_ans_cost.txr': answer(['– ЦЕ КОШТУВАТИМЕ'], 19, [0, 15, 128, 42]),
  'm_16/f5o_ans_cost.txr': answer(['– ЦЕ КОШТУВАТИМЕ'], 19, [0, 15, 128, 42]),
  'm_16/f5p_ans_cost.txr': answer(['– ДОВЕДЕТЬСЯ', 'ЗАПЛАТИТИ'], 2, [0, 0, 128, 46]),
  'm_16/f5n_ans_need.txr': answer(['– ПОТРІБНА', 'ДОПОМОГА?'], 15, [0, 11, 128, 60]),
  'm_16/f5n_ans_nochan.txr': answer(['– БЕЗ ШАНСІВ.'], 27, [0, 22, 128, 47]),
  'm_16/f5o_ans_noway.txr': answer(['– БЕЗ ШАНСІВ.'], 27, [0, 22, 128, 47]),
  'm_16/f5p_ans_whats.txr': answer(['– ЩО', 'СТАЛОСЯ?'], 8, [0, 4, 128, 66]),
  'm_16/f5m_ans_hell.txr': answer(['– ЩО ТРЕБА?'], 23, [0, 18, 128, 46]),
  'm_16/f5o_ans_probl.txr': answer(['– ПРОБЛЕМИ?'], 27, [0, 22, 128, 50]),
};

/** Виміряно на фонах (re/notes/ht2/ui.md §3): клітинки, заголовки, кольори. */
const BACKGROUND_UK: Record<string, Label[]> = {
  ...RADIO_UK,
  'm_16/backf1.txr': [title([116, 417, 274, 437], 'КЛАВІАТУРА', 195, 433, 13, 3)],
  'm_16/backf2.txr': [
    title([131, 414, 259, 437], 'РЕЙТИНГ', 195, 433, 14, 6),
    // Шапка: рядки 451–453 під лінією 450 світліші — опора заповнення нижче, від 454.
    ...([
      [20, 46, 'ЛОГО', 40],
      [75, 97, 'ІМʼЯ', 55],
      [123, 205, 'ЧАСТКА ПЕРЕВЕЗЕНЬ', 90],
      [225, 267, 'НАЙНЯТО', 70],
      [300, 346, 'ТОННАЖ', 70],
    ] as const).map(([x0, x1, t, w]) => {
      const l = at(x0, 455, x1, t, 'center', 'f2', w);
      return { ...l, erase: [l.erase[0], 455, l.erase[2], 468] as Label['erase'] };
    }),
  ],
  'm_16/backf3.txr': [
    title([79, 433, 149, 455], 'ІНФО', 114, 451, 15),
    at(49, 505, 84, 'ЗАМОВЛЕННЯ', 'center', 'f3', 90),
    // Два рядки — одним прямокутником (другий рядок старого напису нижче, ніж вимірялося для першого).
    { ...at(121, 496, 172, 'ПРЕМІЯ', 'center', 'f3', 52), erase: [119, 494, 174, 527] },
    { ...at(121, 511, 172, 'ПЕРШОМУ', 'center', 'f3', 52), erase: [119, 494, 174, 527] },
    // Хвостик «Д» старого «ДЕНЬГИ» — до рядка 584, ліва ніжка — з x 17.
    { ...at(21, 570, 65, 'ГРОШІ', 'left', 'f3', 80), erase: [17, 567, 70, 584] },
    at(120, 570, 172, 'МАШИНА', 'right', 'f3', 55),
    at(22, 611, 80, 'ВАГА ВАНТАЖУ', 'left', 'f3', 68),
    at(96, 611, 170, 'ОБʼЄМ ВАНТАЖУ', 'left', 'f3', 74),
    at(22, 641, 57, 'ШИНИ', 'left', 'f3', 72),
    at(95, 641, 145, 'ГАЛЬМА', 'left', 'f3', 78),
    at(21, 670, 83, 'ДВИГУН', 'left', 'f3', 72),
    at(96, 670, 172, 'ТРАНСМІСІЯ', 'left', 'f3', 78),
  ],
  'm_16/backmy.txr': [
    title([94, 417, 292, 437], 'МОЯ КОМПАНІЯ', 193, 434, 14, 3),
    { ...at(32, 460, 73, 'ГРОШІ', 'left', 'my', 100), erase: [27, 458, 78, 476] },
    at(151, 460, 203, 'МАШИНИ', 'right', 'my', 60),
    at(229, 460, 262, 'ВСЬОГО', 'center', 'my', 70),
    at(290, 460, 358, 'МОЖУ НАЙНЯТИ', 'center', 'my', 72),
    { ...at(32, 505, 124, 'МОЇ ВОДІЇ', 'left', 'my', 120), erase: [28, 503, 140, 521] },
    at(40, 528, 62, 'ІМʼЯ', 'center', 'my', 60),
    at(105, 528, 143, 'АВАНС', 'center', 'my', 55),
    at(166, 528, 220, 'ПРИБУТОК', 'center', 'my', 65),
    at(255, 528, 306, 'МАШИНА', 'center', 'my', 90),
  ],
  'm_16/backescmain.txr': ESC_TITLE,
  'm_16/backescsnd.txr': [
    ...ESC_TITLE,
    ...escLabel(469, 'ЗАГАЛЬНА ГУЧНІСТЬ'),
    ...escLabel(539, 'МУЗИКА'),
    ...escLabel(609, 'ЗВУК ДВИГУНА'),
    ...escLabel(679, 'ЗВУК ГАЛЬМУВАННЯ'),
  ],
  'm_16/backescctrl.txr': [
    ...ESC_TITLE,
    ...escLabel(476, 'ЧУТЛИВІСТЬ\nКЕРМА'),
    ...escLabel(561, 'ПОВЕРНЕННЯ КЕРМА'),
    ...escLabel(631, 'ВІДДАЧА КЕРМА'),
    ...escLabel(696, 'АВТОМАТИЧНА\nКОРОБКА ПЕРЕДАЧ').map((l) => ({ ...l, x: 81, maxW: 112, erase: [24, l.erase[1], 138, l.erase[3]] as Label['erase'] })),
  ],
  'm_16/backservice.txr': [
    title([283, 416, 404, 437], 'СЕРВІС', 343, 434, 15, 6),
    title([296, 459, 402, 478], 'ПОШКОДЖЕННЯ', 349, 475, 14),
    title([292, 570, 398, 590], 'МОДЕРНІЗАЦІЇ', 345, 587, 14),
    ...column(257, 362, 485, 19, ['ДВИГУН', 'КОРОБКА ПЕРЕДАЧ', 'ТРАНСМІСІЯ', 'ГАЛЬМА'], 'right', 'svc'),
    ...column(438, 543, 485, 19, ['ФАРИ', 'КУЗОВ', 'ШИНИ', 'ПОВНИЙ РЕМОНТ'], 'right', 'svc'),
    ...column(257, 362, 598, 19, ['ФОРСОВАНИЙ ДВИГУН', 'ПРИСАДКА В ДВИГУН', 'ПОВІТРОЗАБІРНИК', 'ШИНИ HIGH-WAY', 'ШИНИ ВСЮДИХІД', 'ДОДАТКОВИЙ БАК', 'АБС'], 'right', 'svc'),
    ...column(438, 543, 598, 19, ['РАДАР-ДЕТЕКТОР', 'РАДАР-ГЛУШНИК', 'СКАНЕР ВАНТАЖУ', 'ПОЖЕЖНА СИСТЕМА', 'НАВІГАТОР', 'СИГНАЛ', 'ВСТАНОВИТИ ВСЕ'], 'right', 'svc'),
    ...column(49, 181, 617, 19, ['ПНЕВМОПІДВІСКА', 'ВЕНТИЛЬОВАНІ ГАЛЬМА', 'ГАЛЬМУВАННЯ ДВИГУНОМ', 'ПОСИЛЕНА РАМА', 'БРОНЬОВАНЕ СКЛО', 'ЗАХИСТ ФАР'], 'right', 'svc'),
    { ...cell(164, 269, 748, 'МІЙ БАЛАНС', 'right', 'svcsum'), erase: [164, 747, 269, 764], cap: 12, base: 760 },
    { ...cell(345, 450, 748, 'РАЗОМ', 'right', 'svcsum'), erase: [345, 747, 450, 764], cap: 12, base: 760 },
  ],
  'm_16/backorder.txr': [
    title([69, 415, 182, 437], 'ЗАМОВЛЕННЯ', 125, 433, 15, 2),
    ...column(38, 118, 558, 20, ['ВАНТАЖ', 'КУДИ', 'МАКС. ПРЕМІЯ', 'МАКС. ЧАС', 'ВАГА', 'ОБʼЄМ', 'КРИХКІСТЬ'], 'left', 'ord'),
  ],
  'm_16/backsale.txr': [
    title([58, 415, 192, 437], 'ПРОДАЄТЬСЯ', 125, 434, 15, 1),
    ...column(52, 95, 588, 20, ['КОД', 'ЦІНА'], 'left', 'sale'),
    ...column(52, 135, 628, 20, ['ПОТУЖНІСТЬ', 'ВАНТАЖНІСТЬ'], 'left', 'sale'),
  ],
  'm_16/backgas.txr': [
    // Підписи над табличками цифр — помаранчеві, без клітинок.
    { erase: [64, 446, 135, 463], text: 'СУМА, $', x: 69, base: 460, align: 'left', cap: 10, maxW: 70, group: 'gasplate' },
    { erase: [64, 495, 135, 512], text: 'ЛІТРИ', x: 67, base: 509, align: 'left', cap: 10, maxW: 70, group: 'gasplate' },
    { erase: [64, 545, 135, 562], text: 'ЗА ЛІТР', x: 67, base: 559, align: 'left', cap: 10, maxW: 70, group: 'gasplate' },
    cell(41, 159, 629, 'РІВЕНЬ', 'center', 'gas'),
    cell(162, 207, 628, 'ПОВНИЙ', 'center', 'gas'),
    cell(43, 126, 689, 'ЛІТРИ', 'center', 'gas'),
  ],
};

const FONT = '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';
/** Запас навколо старого напису: тінь зміщена вниз-праворуч. */
const SHADOW = 4;
/** Висота великих літер напису кнопки, px (фрази рації — 11, виміряно рядки 14…24). */
const CAP = 15;
const CAP_FOR = (base: string) => (CENTERED(base) ? 11 : CAP);

/** Пікселі напису: ті, що відрізняються між станами. */
function textMask(states: ImageData[]): Uint8Array {
  const { width: w, height: h } = states[0];
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    for (let s = 1; s < states.length; s++) {
      const a = states[0].data;
      const b = states[s].data;
      if (Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2]) > 24) {
        m[i] = 1;
        break;
      }
    }
  }
  return m;
}

function bbox(mask: Uint8Array, w: number, h: number): [number, number, number, number] | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}

/** Колір напису стану: середнє найсвітлішої третини пікселів маски. */
function inkColor(img: ImageData, mask: Uint8Array): string {
  const px: [number, number, number][] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) px.push([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
  px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const top = px.slice(Math.floor((px.length * 2) / 3));
  if (!top.length) return 'rgb(240,240,240)';
  const avg = [0, 1, 2].map((k) => Math.round(top.reduce((s, p) => s + p[k], 0) / top.length));
  return `rgb(${avg.join(',')})`;
}

/** Заповнює прямокутник по стовпчиках лінійно між пікселем над ним і під ним (край зображення — найближчим рядком). */
function fillColumns(img: ImageData, x0: number, y0: number, x1: number, y1: number): void {
  const { width: w, height: h, data } = img;
  x0 = Math.max(0, x0);
  x1 = Math.min(w - 1, x1);
  const top = y0 - 1;
  const bottom = y1 + 1;
  for (let x = x0; x <= x1; x++) {
    const a = (Math.max(0, top) * w + x) * 4;
    const b = (Math.min(h - 1, bottom) * w + x) * 4;
    // Напис біля краю кнопки — опора лише з одного боку.
    const ia = top < 0 ? b : a;
    const ib = bottom >= h ? a : b;
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
      const t = (y - top) / (bottom - top);
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) data[i + ch] = data[ia + ch] + (data[ib + ch] - data[ia + ch]) * t;
      data[i + 3] = 255;
    }
  }
}

/** Рядок тексту з тінню: висота великих літер cap, базова лінія y; стискається до maxW. */
/** Ширина тексту поточним шрифтом з розрідженням spacing між літерами. */
function textWidth(ctx: CanvasRenderingContext2D, text: string, spacing = 0): number {
  return ctx.measureText(text).width + spacing * Math.max(0, [...text].length - 1);
}

function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  cap: number,
  maxW: number,
  color: string,
  align: 'left' | 'right' | 'center',
  underline = false,
  fixed?: number,
  spacing = 0,
): void {
  ctx.font = `bold ${Math.round(cap / 0.72)}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  const tw = textWidth(ctx, text, spacing);
  const k = fixed ?? Math.min(1, maxW / Math.max(1, tw));
  ctx.save();
  ctx.translate(align === 'center' ? x - (tw * k) / 2 : align === 'right' ? x - tw * k : x, y);
  ctx.scale(k, 1);
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  ctx.shadowBlur = 2;
  ctx.fillStyle = color;
  if (spacing) {
    let cx = 0;
    for (const ch of text) {
      ctx.fillText(ch, cx, 0);
      cx += ctx.measureText(ch).width + spacing;
    }
  } else ctx.fillText(text, 0, 0);
  if (underline) ctx.fillRect(0, 3, tw, 2);
  ctx.restore();
}

function toCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

/**
 * Українські стани кнопки. states — картинки станів (`p`, `a`, `ap`, `f`…; той самий розмір), under — фон панелі під
 * кнопкою того ж розміру (без нього — заповнення по стовпчиках). null — перекладу немає.
 */
export function localizeButton(base: string, states: Record<string, ImageData>, under: ImageData | null): Record<string, HTMLCanvasElement> | null {
  const text = BUTTON_UK[base];
  const keys = Object.keys(states);
  if (!text || keys.length < 2) return null;
  const src = keys.map((k) => states[k]);
  const { width: w, height: h } = src[0];
  const mask = textMask(src);
  const box = bbox(mask, w, h);
  if (!box) return null;
  // Усі кнопки m_16 — одним кеглем, як в оригіналі (великі літери в рядках 1…16 кнопки 150×30, виміряно); базова
  // лінія — під ними.
  const cap = CAP_FOR(base);
  const top = Math.max(1, box[1]);
  const k = scaleFor(base);
  const centered = CENTERED(base);
  const lines = text.split('\n');
  const out: Record<string, HTMLCanvasElement> = {};
  keys.forEach((key, i) => {
    const img = new ImageData(new Uint8ClampedArray(src[i].data), w, h);
    const color = inkColor(src[i], mask);
    const [x0, y0, x1, y1] = [box[0] - 1, box[1] - 1, Math.min(w - 1, box[2] + SHADOW), Math.min(h - 1, box[3] + SHADOW)];
    // Фрази рації мають власну темну смугу під текстом (не фон панелі) — заповнення по стовпчиках її зберігає.
    if (under && under.width === w && under.height === h && !centered) {
      for (let y = Math.max(0, y0); y <= y1; y++)
        for (let x = Math.max(0, x0); x <= x1; x++) {
          const j = (y * w + x) * 4;
          img.data[j] = under.data[j];
          img.data[j + 1] = under.data[j + 1];
          img.data[j + 2] = under.data[j + 2];
          img.data[j + 3] = 255;
        }
    } else fillColumns(img, x0, y0, x1, y1);
    const c = toCanvas(img);
    // Натиснута / вибрана — зсув на піксель і підкреслення, як в оригіналі.
    const pressed = key === 'ap' || key === 'pp';
    const dx = pressed ? 1 : 0;
    if (centered)
      // Посередині кнопки: рядки через 15 px, середина тексту — на середині висоти.
      lines.forEach((line, li) => {
        const base = Math.round(h / 2 + cap / 2 + (li - (lines.length - 1) / 2) * 15) + dx;
        drawText(c.getContext('2d')!, line, w / 2 + dx, base, cap, w - 20, color, 'center', pressed && li === lines.length - 1, k);
      });
    else drawText(c.getContext('2d')!, text, box[0] + dx, top + cap + dx, cap, w - box[0] - 4, color, 'left', pressed, k);
    out[key] = c;
  });
  return out;
}

/**
 * Стирає жовтий текст з темним контуром у прямокутнику: маска — жовті пікселі, розширена на 2 (контур і тінь),
 * заповнюється середнім уже відомих сусідів шарами від краю (фото під написом лишається довкола).
 */
function eraseInk(img: ImageData, x0: number, y0: number, x1: number, y1: number): void {
  const { width: w, height: h, data } = img;
  const todo = new Uint8Array(w * h);
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
      const i = (y * w + x) * 4;
      if (data[i] > 170 && data[i + 1] > 170 && data[i + 2] < 120)
        for (let dy = -2; dy <= 3; dy++)
          for (let dx = -2; dx <= 3; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) todo[yy * w + xx] = 1;
          }
    }
  for (let pass = 0; pass < 40; pass++) {
    const fill: [number, number, number, number][] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!todo[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h || todo[yy * w + xx]) continue;
            const k = (yy * w + xx) * 4;
            r += data[k];
            g += data[k + 1];
            b += data[k + 2];
            n++;
          }
        if (n) fill.push([i, r / n, g / n, b / n]);
      }
    if (!fill.length) break;
    for (const [i, r, g, b] of fill) {
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
      todo[i] = 0;
    }
  }
}

/** Колір старого напису: середнє найсвітлішої шостини пікселів прямокутника. */
function brightest(img: ImageData, [x0, y0, x1, y1]: [number, number, number, number]): string {
  const px: [number, number, number][] = [];
  for (let y = Math.max(0, y0); y <= Math.min(img.height - 1, y1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(img.width - 1, x1); x++) {
      const i = (y * img.width + x) * 4;
      px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
    }
  px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const top = px.slice(Math.floor((px.length * 5) / 6));
  const avg = [0, 1, 2].map((k) => Math.round(top.reduce((s, p) => s + p[k], 0) / Math.max(1, top.length)));
  return `rgb(${avg.join(',')})`;
}

/** Замінює російські підписи фону вікна українськими (на місці). */
export function localizeBackground(name: string, canvas: HTMLCanvasElement): void {
  const items = BACKGROUND_UK[name];
  if (!items) return;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const colors = items.map((it) => it.color ?? brightest(img, it.erase));
  for (const it of items) (it.mode === 'ink' ? eraseInk : fillColumns)(img, ...it.erase);
  ctx.putImageData(img, 0, 0);
  // Одна група — один стиск (за найдовшим підписом відносно його місця).
  const scale = new Map<string, number>();
  items.forEach((it, i) => {
    ctx.font = `bold ${Math.round(it.cap / 0.72)}px ${FONT}`;
    const k = Math.min(1, it.maxW / Math.max(1, textWidth(ctx, it.text, it.spacing)));
    const g = it.group ?? `#${i}`;
    scale.set(g, Math.min(scale.get(g) ?? 1, k));
  });
  items.forEach((it, i) => drawText(ctx, it.text, it.x, it.base, it.cap, it.maxW, colors[i], it.align, false, scale.get(it.group ?? `#${i}`), it.spacing));
}

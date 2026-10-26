/**
 * «Мережева гра» другої гри — власний інтерфейс порту (на прохання користувача, 2026-10-26: екрани оригіналу
 * `n/backMult` / `h/backHost` не дають вибрати кількість суперників, змінити машину в сесії, вибрати збереження
 * мережевої кар'єри). Екрани на весь екран у панелі-склі (ui/art/net-panel.png — згенерована під стиль меню king.exe):
 * 1. машина й «Створити гру» / «Приєднатися» — фото варіантів з вікна замовлення машини (net/cars.ts);
 * 2. налаштування заїзду (сервер): режим, суперники точним числом 0…15 (Кільце, Тріал), складність, доба й погода;
 *    у кар'єрі — повзунок «Насиченість трас»;
 * 3. коди з'єднання (QR, камера, текст) — як раніше;
 * 4. лобі: гравці, заїзд, «+ Гравець», «Моя машина», «Змінити», «Старт»;
 * 5. мережева кар'єра — своє збереження чи нова.
 * Графіка оригіналу: стрілки `aleft`/`aright` і бігунок `runner_*` (LOAD.RES), фото машин `m16\<модель><колір>.msk`
 * (esc16.RES; без нього — картинки марок `n/<марка><колір>.msk`). Сама мережа — net/ (WebRTC у локальній Wi-Fi).
 */
import { DEFAULT_SETUP, NetPeer, type CloseReason, type NetCar, type NetPlayer, type NetSetup, type NetTrack } from '../net/peer';
import { MAX_PLAYERS, NetSession } from '../net/session';
import { PLAYER_COLORS } from '../net/state';
import { QrScanner, cameraAvailable, qrCanvas } from '../net/qr';
import { KIND_NAME, MAX_RIVALS, NET_MODELS, brandPhoto, carName, carPhoto, clampRivals, hasRivals, pickRivals } from '../net/cars';
import { deleteSave, formatMoney, listNetSaves, type Ht2Career } from '../career/career';
import { MAX_CAREER_PLAYERS, type AllyStart, type CareerKind } from '../career/allies';
import { texButtonEl, type Ht2MenuArt, type RoundKey } from './menu';
import type { EscArt } from './escArt';
import panelUrl from './art/net-panel.png';
import iconsUrl from './art/net-icons.png';

export { DEFAULT_CAR, carName } from '../net/cars';

/** Скільки чекати з'єднання після обміну кодами, мс. */
const CONNECT_TIMEOUT = 15000;

const CLOSE_TEXT: Record<CloseReason, string> = {
  bye: 'Друг вийшов із гри.',
  lost: 'Зв’язок із другом втрачено.',
  failed: 'Не вдалося з’єднатися: телефони мають бути в одній Wi-Fi мережі.',
  version: 'У друга інша версія гри — оновіть обидва телефони.',
  local: '',
};

const TRACK_NAME: Record<NetTrack, string> = { ring: 'Кільце', trial: 'Тріал', ball: 'Автобол', career: 'Кар’єра' };

/** Початок заїзду: сесія, вибір господаря, гравці з машинами, машини суперників (номери від FIRST_RIVAL). */
export interface NetStart {
  session: NetSession;
  setup: NetSetup;
  players: NetPlayer[];
  rivals: NetCar[];
  /** Мережева кар'єра «Союзники»: спільна компанія сервера й особисте кожного (career/allies.ts). */
  ally?: AllyStart;
}

/** Потужність (к. с., evehicles.sch — як у вікні замовлення) і вантажопідйомність (т, vehicle.tech) моделі. */
export type CarSpecs = Map<string, { power: number; capacity: number }>;

export interface NetMenuOptions {
  driver: string;
  /** Машина з минулого разу. */
  car: NetCar;
  /** Повернення із заїзду до тієї ж сесії. */
  from?: NetSession | null;
  /** Машину змінено — зберегти вибір. */
  onCar?(car: NetCar): void;
  /** Графіка esc16.RES (фото машин); null — немає файлу. */
  escArt?: Promise<EscArt | null>;
  /** Потужність і вантажопідйомність моделей. */
  specs?: Promise<CarSpecs>;
  /** Мережева кар'єра: вибране збереження режиму (undefined — найновіше, null — нова) і зміна вибору. */
  careerSave?: { get(kind: CareerKind): string | null | undefined; set(kind: CareerKind, id: string | null): void };
  /** Сервер, старт кар'єри «Союзники»: спільна компанія зі свого збереження для гостей. */
  allyStart?(car: NetCar): AllyStart;
}

/** Режим мережевої кар'єри. */
const kindOf = (s: NetSetup): CareerKind => s.career ?? 'rivals';
const KIND_TITLE: Record<CareerKind, string> = { rivals: 'суперництво', allies: 'союзники' };

/**
 * Розділ «Мережева гра»: машина → «Створити гру» (налаштування → коди) чи «Приєднатися» (коди) → лобі. Результат —
 * початок заїзду чи null (головне меню). RoundKey — лише для сумісності з рештою меню (тут круглих кнопок немає).
 */
export async function ht2NetMenu(art: Ht2MenuArt, o: NetMenuOptions): Promise<NetStart | RoundKey | null> {
  const photos = new CarPhotos(art, o.escArt);
  const specs = o.specs ?? Promise.resolve<CarSpecs>(new Map());
  let note: string | null = null;
  let session = o.from ?? null;
  let car: NetCar = { ...(session?.me ?? o.car) };
  for (;;) {
    if (!session || session.closed) {
      const r = await carScreen(art, photos, specs, o.driver, car, note);
      note = null;
      if (!r) return null;
      car = r.car;
      o.onCar?.({ ...car });
      if (r.go === 'host') {
        const setup = await setupScreen(art, { ...DEFAULT_SETUP }, false);
        if (!setup) continue;
        const peer = await connectPanel(art, o.driver, 'host', false);
        if (!peer) continue;
        session = NetSession.hostFor(o.driver, car, setup);
        session.addGuest(peer);
      } else {
        const peer = await connectPanel(art, o.driver, 'join', false);
        if (!peer) continue;
        try {
          session = await NetSession.join(peer, o.driver, car);
        } catch (e) {
          note = e instanceof Error ? e.message : String(e);
          session = null;
          continue;
        }
      }
    }
    const r = await lobby(art, photos, o, session);
    // Поки відкрито інший екран, сесію веде сама сесія (гості чекають, списки оновлюються).
    session.events = {};
    if (r === 'add') {
      const peer = await connectPanel(art, o.driver, 'host', true);
      if (peer && !session.closed) session.addGuest(peer);
      else peer?.close();
      continue;
    }
    if (r === 'setup') {
      const s = await setupScreen(art, session.setup, true);
      if (s && !session.closed) session.setSetup(s);
      continue;
    }
    if (r === 'car') {
      const c = await carScreen(art, photos, specs, o.driver, session.me, null, true);
      if (c && !session.closed) {
        car = c.car;
        session.pickCar(car);
        o.onCar?.({ ...car });
      }
      continue;
    }
    if (r === 'save') {
      const kind = kindOf(session.setup);
      const s = await saveScreen(art, photos, o.driver, o.careerSave?.get(kind), car, kind);
      if (s !== undefined) o.careerSave?.set(kind, s);
      continue;
    }
    if (r && typeof r === 'object') return r;
    note = r;
    session = null;
  }
}

// ——— Фото машин ———

/** Фото варіантів: esc16.RES (коли довантажиться — onReady), до того й без нього — картинка марки з LOAD.RES. */
class CarPhotos {
  private esc: EscArt | null = null;
  private waiting = new Set<() => void>();
  constructor(
    private readonly art: Ht2MenuArt,
    esc?: Promise<EscArt | null>,
  ) {
    void esc?.then((e) => {
      this.esc = e;
      if (e) for (const f of this.waiting) f();
      this.waiting.clear();
    });
  }
  /** URL фото (null — немає жодного). */
  url(truck: string, color: number): string | null {
    const name = carPhoto(truck, color);
    if (this.esc?.has(name)) return this.esc.url(name);
    const b = brandPhoto(truck, color);
    return b ? this.art.image(b) : null;
  }
  /** Перемалювати, коли з'являться справжні фото варіантів (лише раз). */
  onReady(f: () => void): void {
    if (!this.esc) this.waiting.add(f);
  }
}

// ——— Будівельні блоки ———

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Екран на весь вікно: панель-скло із заголовком, вміст і рядок кнопок унизу. */
function frame(title: string): { root: HTMLElement; head: HTMLElement; sub: HTMLElement; body: HTMLElement; foot: HTMLElement; close: () => void } {
  const root = el('div', 'ht2-nui');
  root.style.setProperty('--nui-panel', `url("${panelUrl}")`);
  root.style.setProperty('--nui-icons', `url("${iconsUrl}")`);
  const panel = el('div', 'ht2-nui-panel');
  const top = el('div', 'ht2-nui-top');
  const head = el('div', 'ht2-nui-title', title);
  const sub = el('div', 'ht2-nui-sub');
  top.append(head, sub);
  const body = el('div', 'ht2-nui-body');
  const foot = el('div', 'ht2-nui-foot');
  panel.append(top, body, foot);
  root.append(panel);
  document.body.append(root);
  document.body.classList.add('in-menu');
  return {
    root,
    head,
    sub,
    body,
    foot,
    close: () => {
      root.remove();
      if (!document.querySelector('.ht2-nui, .menu-screen')) document.body.classList.remove('in-menu');
    },
  };
}

/** Кнопка-«пігулка» (зелена; primary — світла, як вибрана кнопка оригіналу). */
function btn(text: string, action: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', `ht2-nui-btn ${cls}`.trim(), text);
  b.addEventListener('click', action);
  return b;
}

/** Стрілка оригіналу (`aleft`/`aright` з LOAD.RES). */
function arrow(art: Ht2MenuArt, dir: 'left' | 'right', label: string, action: () => void, disabled?: () => boolean): { button: HTMLButtonElement; paint: () => void } {
  const r = texButtonEl(art, dir === 'left' ? 'aleft' : 'aright', label, { ext: '.msk', action, disabled });
  r.button.classList.add('ht2-nui-arrow');
  return r;
}

/** Значок з аркуша ui/art/net-icons.png: 0 — сервер, 1 — на трасі, 2 — немає зв'язку, 3 — нове. */
function icon(i: number, title: string): HTMLElement {
  const e = el('i', 'ht2-nui-icon');
  e.style.backgroundPosition = `${(i * 100) / 3}% 0`;
  e.title = title;
  return e;
}

/** Рядок «підпис ◀ значення ▶» (лічильник). Повертає перемальовування. */
function stepper(art: Ht2MenuArt, parent: HTMLElement, label: string, get: () => number, set: (v: number) => void, min: number, max: number, hint: () => string): () => void {
  const row = el('div', 'ht2-nui-field');
  const name = el('span', 'ht2-nui-label', label);
  const value = el('span', 'ht2-nui-count');
  const tip = el('span', 'ht2-nui-hint');
  const paints: (() => void)[] = [];
  const paint = () => {
    value.textContent = String(get());
    tip.textContent = hint();
    paints.forEach((p) => p());
  };
  const l = arrow(art, 'left', `${label}: менше`, () => (set(Math.max(min, get() - 1)), paint()), () => get() <= min);
  const r = arrow(art, 'right', `${label}: більше`, () => (set(Math.min(max, get() + 1)), paint()), () => get() >= max);
  paints.push(l.paint, r.paint);
  row.append(name, l.button, value, r.button, tip);
  parent.append(row);
  paint();
  return paint;
}

/** Повзунок 0…1 (крок 0,1): стрілки й бігунок `runner_*` оригіналу. Повертає перемальовування. */
function slider(art: Ht2MenuArt, parent: HTMLElement, label: string, get: () => number, set: (v: number) => void): () => void {
  const row = el('div', 'ht2-nui-field');
  const name = el('span', 'ht2-nui-label', label);
  const bar = el('div', 'ht2-nui-bar');
  const knob = el('img', 'ht2-nui-knob') as HTMLImageElement;
  knob.alt = '';
  knob.draggable = false;
  bar.append(knob);
  let drag = false;
  const paints: (() => void)[] = [];
  const put = (v: number) => {
    set(Math.round(Math.min(1, Math.max(0, v)) * 10) / 10);
    paint();
  };
  const paint = () => {
    knob.src = art.image(`runner_${drag ? 'ap' : 'p'}.msk`) ?? '';
    knob.style.left = `${get() * 100}%`;
    paints.forEach((p) => p());
  };
  const l = arrow(art, 'left', `${label}: менше`, () => put(get() - 0.1), () => get() <= 0);
  const r = arrow(art, 'right', `${label}: більше`, () => put(get() + 0.1), () => get() >= 1);
  paints.push(l.paint, r.paint);
  const fromEvent = (e: PointerEvent) => {
    const b = bar.getBoundingClientRect();
    put((e.clientX - b.left) / Math.max(1, b.width));
  };
  bar.addEventListener('pointerdown', (e) => {
    drag = true;
    bar.setPointerCapture(e.pointerId);
    fromEvent(e);
  });
  bar.addEventListener('pointermove', (e) => drag && fromEvent(e));
  const up = () => {
    drag = false;
    paint();
  };
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
  row.append(name, l.button, bar, r.button);
  parent.append(row);
  paint();
  return paint;
}

/** Перемикач-«пігулки» (одна вибрана). Повертає перемальовування. */
function choice<T>(parent: HTMLElement, items: [T, string][], get: () => T, set: (v: T) => void, after?: () => void, label?: string): () => void {
  const row = el('div', 'ht2-nui-tabs');
  if (label) {
    row.classList.add('ht2-nui-field');
    row.append(el('span', 'ht2-nui-label', label));
  }
  const bs = items.map(([v, text]) => {
    const b = btn(text, () => {
      set(v);
      paint();
      after?.();
    });
    row.append(b);
    return [v, b] as const;
  });
  const paint = () => bs.forEach(([v, b]) => b.classList.toggle('on', v === get()));
  parent.append(row);
  paint();
  return paint;
}

// ——— 1. Машина ———

/**
 * Машина гравця: фото варіанта між стрілками, назва з варіантом, потужність і вантажопідйомність, колір 1–4. pick —
 * зміна машини з лобі («Готово»); інакше — «Створити гру» / «Приєднатися».
 */
function carScreen(
  art: Ht2MenuArt,
  photos: CarPhotos,
  specs: Promise<CarSpecs>,
  driver: string,
  from: NetCar,
  note: string | null,
  pick = false,
): Promise<{ car: NetCar; go: 'host' | 'join' | 'pick' } | null> {
  return new Promise((resolve) => {
    const f = frame(pick ? 'Моя машина' : 'Мережева гра');
    f.sub.textContent = `Водій: ${driver}`;
    let i = Math.max(0, NET_MODELS.findIndex((c) => c.truck === from.truck));
    let color = from.color & 3;
    let spec: CarSpecs = new Map();
    const done = (go: 'host' | 'join' | 'pick' | null) => {
      f.close();
      resolve(go ? { car: { truck: NET_MODELS[i].truck, color }, go } : null);
    };
    const left = el('div', 'ht2-nui-col ht2-nui-carcol');
    const view = el('div', 'ht2-nui-carview');
    const pic = el('img', 'ht2-nui-photo') as HTMLImageElement;
    pic.alt = '';
    pic.draggable = false;
    const step = (d: number) => () => {
      i = (i + d + NET_MODELS.length) % NET_MODELS.length;
      paint();
    };
    const l = arrow(art, 'left', 'Попередня машина', step(-1));
    const r = arrow(art, 'right', 'Наступна машина', step(1));
    view.append(l.button, pic, r.button);
    const name = el('div', 'ht2-nui-carname');
    const info = el('div', 'ht2-nui-hint');
    left.append(view, name, info);
    stepper(art, left, 'Колір', () => color + 1, (v) => {
      color = v - 1;
      paint();
    }, 1, 4, () => '');
    const right = el('div', 'ht2-nui-col ht2-nui-actions');
    const tip = el('div', note ? 'ht2-nui-note warn' : 'ht2-nui-note', note ?? 'Телефони — в одній Wi-Fi мережі; коди з’єднання — QR або текстом.');
    if (pick) right.append(btn('Готово', () => done('pick'), 'primary'), btn('Скасувати', () => done(null)), tip);
    else right.append(btn('Створити гру', () => done('host'), 'primary'), btn('Приєднатися', () => done('join')), tip);
    f.body.append(left, right);
    if (!pick) f.foot.append(btn('Назад', () => done(null)));
    const paint = () => {
      const c = NET_MODELS[i];
      pic.src = photos.url(c.truck, color) ?? '';
      pic.hidden = !pic.src;
      name.textContent = `${c.name} — ${KIND_NAME[c.kind]}`;
      const s = spec.get(c.truck);
      info.textContent = s ? `${s.power} к. с. · ${s.capacity} т` : '';
    };
    photos.onReady(paint);
    void specs.then((s) => {
      spec = s;
      paint();
    });
    paint();
  });
}

// ——— 2. Налаштування заїзду ———

/** Налаштування заїзду (сервер): режим, суперники, складність, доба, погода; кар'єра — насиченість трас. */
function setupScreen(art: Ht2MenuArt, from: NetSetup, inSession: boolean): Promise<NetSetup | null> {
  return new Promise((resolve) => {
    const s: NetSetup = { ...DEFAULT_SETUP, ...from, rivals: clampRivals(from.rivals ?? DEFAULT_SETUP.rivals) };
    const f = frame('Налаштування заїзду');
    f.sub.textContent = 'Обирає сервер; гравці бачать вибір у лобі';
    const done = (v: NetSetup | null) => {
      f.close();
      resolve(v);
    };
    const col = el('div', 'ht2-nui-col ht2-nui-wide');
    f.body.append(col);
    const parts = el('div', 'ht2-nui-fields');
    const build = () => {
      parts.replaceChildren();
      const career = s.track === 'career';
      if (hasRivals(s.track))
        stepper(art, parts, 'Суперники', () => s.rivals, (v) => (s.rivals = v), 0, MAX_RIVALS, () => `0…${MAX_RIVALS}, на автопілоті`);
      else if (s.track === 'ball') parts.append(el('div', 'ht2-nui-note', 'В Автоболі суперників на автопілоті немає (як в оригіналі).'));
      if (career) {
        const note = el('div', 'ht2-nui-note');
        const tell = () =>
          (note.textContent =
            kindOf(s) === 'allies'
              ? `Спільна компанія: гроші, наймані й ліцензії — одні на всіх, збереження — у сервера. До ${MAX_CAREER_PLAYERS} гравців.`
              : `Кожен — своя компанія і своє збереження; хто перший захопить 51 % ринку — виграв. До ${MAX_CAREER_PLAYERS} гравців.`);
        choice(parts, [['rivals', 'Суперництво'], ['allies', 'Союзники']] as [CareerKind, string][], () => kindOf(s), (v) => (s.career = v), tell, 'Компанія');
        slider(art, parts, 'Насиченість трас', () => s.traffic, (v) => (s.traffic = v));
        slider(art, parts, 'Тривалість доби', () => s.dayLength, (v) => (s.dayLength = v));
        slider(art, parts, 'Погода', () => s.weather, (v) => (s.weather = v));
        parts.append(note);
        tell();
        return;
      }
      choice(parts, [[true, 'Аркада'], [false, 'Симулятор']], () => s.arcade, (v) => (s.arcade = v), undefined, 'Складність');
      slider(art, parts, 'Тривалість доби', () => s.dayLength, (v) => (s.dayLength = v));
      slider(art, parts, 'Погода', () => s.weather, (v) => (s.weather = v));
    };
    choice(col, [['ring', 'Кільце'], ['trial', 'Тріал'], ['ball', 'Автобол'], ['career', 'Кар’єра']] as [NetTrack, string][], () => s.track, (v) => (s.track = v), build);
    col.append(parts);
    build();
    f.foot.append(btn(inSession ? 'Скасувати' : 'Назад', () => done(null)), btn(inSession ? 'Готово' : 'Далі — запросити гравців', () => done(s), 'primary'));
  });
}

// ——— 3. Коди з'єднання ———

/**
 * Обмін кодами з'єднання (як у першій грі): господар — QR-код запрошення, камера чекає відповідь друга; гість — камера
 * сканує запрошення, далі QR-код відповіді. «Код текстом» — ті самі коди текстом (без камери: dev-сервер без HTTPS,
 * ПК; або надіслати месенджером). Результат — з'єднаний друг (null — назад).
 */
function connectPanel(art: Ht2MenuArt, driver: string, mode: 'host' | 'join', adding: boolean): Promise<NetPeer | null> {
  void art;
  return new Promise((resolve) => {
    const f = frame(mode === 'host' ? (adding ? 'Новий гравець' : 'Створити гру') : 'Приєднатися');
    f.sub.textContent = mode === 'host' ? 'Покажіть код другу, потім відскануйте його відповідь' : 'Відскануйте код друга, що створив гру, і покажіть йому свій';
    const qrBox = el('div', 'ht2-net-qr');
    const right = el('div', 'ht2-nui-col ht2-net-right');
    const video = el('video', 'ht2-net-video');
    video.muted = true;
    video.playsInline = true;
    const codes = el('div', 'ht2-net-codes');
    const ownLabel = el('div', '', 'Ваш код:');
    const own = el('textarea', 'ht2-net-code');
    own.readOnly = true;
    own.addEventListener('focus', () => own.select());
    const share = typeof navigator.share === 'function';
    const send = btn(share ? 'Надіслати' : 'Копіювати', () => void sendCode(own, share), 'small');
    const friendLabel = el('div', '', 'Код друга:');
    const friend = el('textarea', 'ht2-net-code');
    friend.placeholder = 'вставте код';
    friend.addEventListener('input', () => {
      const v = friend.value.replace(/\s+/g, '').toUpperCase();
      if (v.startsWith('HT2:') && v.length > 60) void gotCode(v);
    });
    codes.append(ownLabel, own, send, friendLabel, friend);
    const status = el('div', 'ht2-nui-note');
    right.append(video, codes, status);
    f.body.append(qrBox, right);
    const toggle = btn('', () => {
      textMode = !textMode;
      layout();
    });
    f.foot.append(btn('Назад', () => done(null)), toggle);

    const camera = cameraAvailable();
    let textMode = !camera;
    let peer: NetPeer | null = null;
    let scanner: QrScanner | null = null;
    let busy = false;
    let lastBad = '';
    let timeout = 0;
    let closed = false;

    const say = (text: string) => (status.textContent = text);
    const needScan = () => !closed && ((mode === 'host' && !!peer && !busy) || (mode === 'join' && !peer && !busy));
    const updateScan = () => {
      const want = needScan() && !textMode && camera;
      if (want && !scanner) {
        scanner = new QrScanner(video, (c) => void gotCode(c));
        scanner.start().catch((e: unknown) => {
          scanner?.stop();
          scanner = null;
          textMode = true;
          layout();
          say(`${cameraError(e)} — обміняйтеся кодами текстом.`);
        });
      } else if (!want && scanner) {
        scanner.stop();
        scanner = null;
      }
    };
    const layout = () => {
      qrBox.hidden = !qrBox.firstChild;
      video.hidden = textMode || !needScan();
      codes.hidden = !textMode;
      friend.disabled = !needScan();
      toggle.hidden = !camera;
      toggle.textContent = textMode ? 'Камера' : 'Код текстом';
      updateScan();
    };
    // Дотик до QR-коду — на весь екран (більші клітинки — камера друга читає з більшої відстані).
    qrBox.title = 'Торкніться — більше';
    qrBox.addEventListener('click', () => own.value && showBigQr(own.value));
    const showCode = (code: string) => {
      qrBox.replaceChildren(qrCanvas(code, 300));
      own.value = code;
    };
    const done = (v: NetPeer | null) => {
      closed = true;
      clearTimeout(timeout);
      scanner?.stop();
      scanner = null;
      if (!v) peer?.close();
      f.close();
      resolve(v);
    };
    const watch = (p: NetPeer) => {
      p.events = {
        onReady: () => done(p),
        onClose: (reason) => {
          if (p !== peer) return;
          peer = null;
          busy = false;
          if (reason !== 'local') say(CLOSE_TEXT[reason] || 'З’єднання закрито.');
          if (mode === 'host') void startHost();
          else layout();
        },
      };
    };
    const connecting = () => {
      say('З’єднуємо…');
      timeout = window.setTimeout(() => say('Не з’єднується. Перевірте, що обидва телефони в одній Wi-Fi мережі, і спробуйте ще раз.'), CONNECT_TIMEOUT);
    };
    const startHost = async () => {
      busy = true;
      say('Готуємо запрошення…');
      layout();
      try {
        const r = await NetPeer.host(driver);
        if (closed) return r.peer.close();
        peer = r.peer;
        watch(peer);
        showCode(r.code);
        busy = false;
        say(textMode ? 'Надішліть код другу й вставте його відповідь.' : 'Покажіть код другу (дотик — більше), потім наведіть камеру на його відповідь.');
      } catch (e) {
        say(`Помилка: ${e instanceof Error ? e.message : String(e)}`);
        busy = false;
      }
      layout();
    };
    /** Розпізнаний код (камера чи текст): для господаря — відповідь друга, для гостя — запрошення. */
    const gotCode = async (code: string) => {
      if (busy || code === lastBad || !needScan()) return;
      busy = true;
      layout();
      try {
        if (mode === 'host' && peer) {
          await peer.accept(code);
          if (closed) return;
          connecting();
        } else if (mode === 'join') {
          say('Готуємо відповідь…');
          const r = await NetPeer.join(driver, code);
          if (closed) return r.peer.close();
          peer = r.peer;
          watch(peer);
          showCode(r.code);
          say(textMode ? 'Надішліть цей код другу.' : 'Покажіть цей код другу (дотик — більше).');
          connecting();
        }
      } catch (e) {
        if (closed) return;
        lastBad = code;
        busy = false;
        say(e instanceof Error ? e.message : String(e));
      }
      layout();
    };
    if (mode === 'host') void startHost();
    else {
      say(textMode ? 'Вставте код друга, що створив гру.' : 'Наведіть камеру на QR-код друга, що створив гру.');
      layout();
    }
  });
}

// ——— 4. Лобі ———

/** Короткий опис заїзду для лобі. */
export function setupSummary(s: NetSetup): string[] {
  if (s.track === 'career')
    return [
      `Мережева кар’єра: ${KIND_TITLE[kindOf(s)]}`,
      kindOf(s) === 'allies' ? 'Спільна компанія сервера' : 'Кожен — своя компанія, змагання за ринок',
      `Трафік ${Math.round(s.traffic * 100)} % · доба ${Math.round(s.dayLength * 100)} % · погода ${Math.round(s.weather * 100)} %`,
    ];
  const rivals = hasRivals(s.track) ? `Суперники: ${clampRivals(s.rivals)}` : 'Без суперників на автопілоті';
  return [`${TRACK_NAME[s.track]} · ${s.arcade ? 'аркада' : 'симулятор'}`, rivals, `Доба ${Math.round(s.dayLength * 100)} % · погода ${Math.round(s.weather * 100)} %`];
}

/** Назва збереження мережевої кар'єри: гроші, машина, дата. */
function saveTitle(c: Ht2Career): string {
  const date = c.savedAt ? new Date(c.savedAt).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' }) : '';
  return `${formatMoney(c.money)} · ${carName(c.truck)}${date ? ` · ${date}` : ''}`;
}

/**
 * Лобі: гравці (до 8) з машинами, кольором і затримкою; сервер додає гравців, змінює заїзд, починає; кожен може
 * змінити свою машину; у кар'єрі — вибір свого збереження. Результат — початок заїзду, дія ('add', 'setup', 'car',
 * 'save') чи причина закриття для екрана машини (null — вийшли самі).
 */
function lobby(art: Ht2MenuArt, photos: CarPhotos, o: NetMenuOptions, session: NetSession): Promise<NetStart | 'add' | 'setup' | 'car' | 'save' | string | null> {
  void art;
  return new Promise((resolve) => {
    const host = session.host;
    const f = frame('Лобі');
    const left = el('div', 'ht2-nui-col ht2-nui-players');
    const list = el('div', 'ht2-nui-list');
    const leftButtons = el('div', 'ht2-nui-row');
    left.append(list, leftButtons);
    const right = el('div', 'ht2-nui-col ht2-nui-side');
    const summary = el('div', 'ht2-nui-summary');
    const saveBox = el('div', 'ht2-nui-save');
    const status = el('div', 'ht2-nui-note');
    right.append(summary, saveBox, status);
    f.body.append(left, right);
    const done = (v: NetStart | 'add' | 'setup' | 'car' | 'save' | string | null) => {
      clearInterval(timer);
      session.events = {};
      f.close();
      resolve(v);
    };
    const add = host ? btn('+ Гравець', () => done('add')) : null;
    if (add) leftButtons.append(add);
    leftButtons.append(btn('Моя машина', () => done('car')));
    const change = host ? btn('Змінити заїзд', () => done('setup')) : null;
    if (change) right.insertBefore(change, saveBox);
    const start = host
      ? btn(
          'Старт',
          () => {
            if (session.players.size < 2 || tooMany()) return;
            const s = session.setup;
            const ally = s.track === 'career' && kindOf(s) === 'allies' ? o.allyStart?.(session.me) : undefined;
            const m = session.start(pickRivals(s, [...session.players.values()].map((p) => p.truck)), ally);
            done({ session, setup: m.setup, players: m.players, rivals: m.rivals, ally });
          },
          'primary',
        )
      : null;
    const leave = () => {
      session.close();
      done(null);
    };
    /** Мережева кар'єра — до MAX_CAREER_PLAYERS гравців (гонки — до 8). */
    const tooMany = () => session.setup.track === 'career' && session.players.size > MAX_CAREER_PLAYERS;
    f.foot.append(btn('Вийти', leave));
    if (start) f.foot.append(start);
    const renderList = () => {
      f.sub.textContent = `Гравці: ${session.players.size} з ${MAX_PLAYERS}`;
      list.replaceChildren(
        ...[...session.players.values()]
          .sort((a, b) => a.id - b.id)
          .map((p) => {
            const me = p.id === session.myId;
            const line = el('div', me ? 'ht2-nui-player me' : 'ht2-nui-player');
            const sq = el('i', 'ht2-nui-color');
            sq.style.background = PLAYER_COLORS[p.id] ?? '#fff';
            const thumb = el('img', 'ht2-nui-thumb') as HTMLImageElement;
            thumb.alt = '';
            thumb.src = photos.url(p.truck, p.color) ?? '';
            thumb.hidden = !thumb.src;
            const who = el('span', 'ht2-nui-who', `${p.id + 1}. ${me ? o.driver : p.name}${me ? ' (ви)' : ''}`);
            const car = el('span', 'ht2-nui-hint', carName(p.truck));
            // Зв'язок завис (М5): господар знає про кожного гостя, гість — про сервер (і про інших — від сервера).
            const stalled = p.stalled || (!host && p.id === 0 && !!session.link(0)?.stalled);
            const ms = me || (!host && p.id !== 0) ? null : session.rtt(p.id);
            const state = el('span', 'ht2-nui-ms', stalled ? '' : ms !== null ? `${Math.round(ms)} мс` : '');
            const text = el('div', 'ht2-nui-pl');
            text.append(who, car);
            line.append(sq, thumb, text);
            if (p.id === 0) line.append(icon(0, 'Сервер'));
            if (p.driving && !me) line.append(icon(1, 'На трасі'));
            if (stalled) {
              line.classList.add('stalled');
              line.append(icon(2, 'Немає зв’язку'));
            }
            line.append(state);
            return line;
          }),
      );
    };
    const render = () => {
      renderList();
      const s = session.setup;
      summary.replaceChildren(el('div', 'ht2-nui-label', 'Заїзд'), ...setupSummary(s).map((t, k) => el('div', k ? 'ht2-nui-hint' : 'ht2-nui-value', t)));
      if (add) add.hidden = session.full || (s.track === 'career' && session.players.size >= MAX_CAREER_PLAYERS);
      // Мережева кар'єра: у суперництві кожен обирає своє збереження; у союзників — збереження сервера.
      saveBox.replaceChildren();
      if (s.track === 'career') {
        const kind = kindOf(s);
        if (kind === 'allies' && !host) saveBox.append(el('div', 'ht2-nui-label', 'Компанія'), el('div', 'ht2-nui-value', 'Спільна, у сервера'));
        else {
          const id = o.careerSave?.get(kind);
          const saves = listNetSaves(o.driver, kind === 'allies');
          const cur = id === null ? null : id === undefined ? (saves[0] ?? null) : (saves.find((c) => c.id === id) ?? null);
          saveBox.append(
            el('div', 'ht2-nui-label', kind === 'allies' ? 'Спільна компанія' : 'Моя кар’єра'),
            el('div', 'ht2-nui-value', cur ? saveTitle(cur) : 'Нова кар’єра'),
            btn('Обрати збереження', () => done('save'), 'small'),
          );
        }
      }
      status.textContent = tooMany()
        ? `У мережевій кар’єрі — до ${MAX_CAREER_PLAYERS} гравців: зайві мають вийти, або оберіть гонку.`
        : host
        ? session.players.size > 1
          ? s.track === 'career'
            ? 'Старт — кожен у своїй мережевій кар’єрі, в одному світі.'
            : 'Старт — усі завантажать трасу разом з вами.'
          : 'Додайте гравця (+ Гравець), щоб почати.'
        : 'Заїзд обирає сервер. Чекаємо, поки він почне.';
      start?.classList.toggle('off', session.players.size < 2 || tooMany());
    };
    const timer = window.setInterval(renderList, 1000);
    session.events = {
      onChange: render,
      onMessage: (m) => {
        if (m.t === 'start') done({ session, setup: m.setup, players: m.players, rivals: m.rivals, ally: m.ally });
        else render();
      },
      onStall: render,
      onLeave: (id, reason) => {
        if (id === 0) return done(reason === 'bye' ? 'Сервер вийшов з гри.' : CLOSE_TEXT[reason] || null);
        render();
      },
    };
    photos.onReady(renderList);
    // Повернення із заїзду — інші мають знати (у них машина зникає, у сесії — не «на трасі»).
    if (session.me.driving) session.backToLobby();
    render();
  });
}

// ——— 5. Збереження мережевої кар'єри ———

/**
 * Вибір збереження мережевої кар'єри: свої збереження (найновіші першими) і «Нова кар'єра» (з машиною з екрана
 * машини). Результат — id, null (нова) чи undefined (скасовано).
 */
function saveScreen(art: Ht2MenuArt, photos: CarPhotos, driver: string, current: string | null | undefined, car: NetCar, kind: CareerKind): Promise<string | null | undefined> {
  void art;
  return new Promise((resolve) => {
    const allied = kind === 'allies';
    const f = frame(allied ? 'Спільна компанія' : 'Моя мережева кар’єра');
    f.sub.textContent = allied ? `Збереження сервера (${driver}) — у ньому машини всіх союзників` : `Водій: ${driver}`;
    let saves = listNetSaves(driver, allied);
    let pick: string | null = current === undefined ? (saves[0]?.id ?? null) : current;
    let confirmDel = false;
    const done = (v: string | null | undefined) => {
      f.close();
      resolve(v);
    };
    const left = el('div', 'ht2-nui-col ht2-nui-players');
    const list = el('div', 'ht2-nui-list');
    left.append(list);
    const right = el('div', 'ht2-nui-col ht2-nui-side');
    const pic = el('img', 'ht2-nui-photo') as HTMLImageElement;
    pic.alt = '';
    const about = el('div', 'ht2-nui-note');
    right.append(pic, about);
    f.body.append(left, right);
    const del = btn('Видалити', () => {
      if (!pick) return;
      if (!confirmDel) {
        confirmDel = true;
        return paint();
      }
      deleteSave(pick);
      saves = listNetSaves(driver, allied);
      pick = saves[0]?.id ?? null;
      confirmDel = false;
      paint();
    });
    f.foot.append(btn('Назад', () => done(undefined)), del, btn('Обрати', () => done(pick), 'primary'));
    const paint = () => {
      list.replaceChildren(
        ...saves.map((c) => {
          const row = el('button', `ht2-nui-player pick${c.id === pick ? ' on' : ''}`);
          row.append(el('span', 'ht2-nui-who', saveTitle(c)), el('span', 'ht2-nui-hint', `доставок ${c.delivered}`));
          row.addEventListener('click', () => {
            pick = c.id ?? null;
            confirmDel = false;
            paint();
          });
          return row;
        }),
        (() => {
          const row = el('button', `ht2-nui-player pick${pick === null ? ' on' : ''}`);
          row.append(icon(3, 'Нова'), el('span', 'ht2-nui-who', 'Нова кар’єра'), el('span', 'ht2-nui-hint', carName(car.truck)));
          row.addEventListener('click', () => {
            pick = null;
            confirmDel = false;
            paint();
          });
          return row;
        })(),
      );
      const c = saves.find((x) => x.id === pick);
      pic.src = c ? (photos.url(c.truck, c.paint ?? 0) ?? '') : (photos.url(car.truck, car.color) ?? '');
      pic.hidden = !pic.src;
      const members = c?.allies ? Object.keys(c.allies) : [];
      about.textContent = c
        ? allied
          ? `Гроші, наймані й ліцензії компанії, машини союзників${members.length ? ` (${members.join(', ')})` : ''} — зі збереження.`
          : 'Машина, гроші й найняті — зі збереження; світ свій, доба й погода — як у сервера.'
        : 'Нова кар’єра: 5000 $ і машина з екрана «Мережева гра».';
      del.hidden = !c;
      del.textContent = confirmDel ? 'Точно видалити?' : 'Видалити';
    };
    photos.onReady(paint);
    paint();
  });
}

/** QR-код на весь екран (найбільший квадрат вікна), дотик чи Esc — закрити. */
function showBigQr(code: string): void {
  const back = el('div', 'ht2-net-bigqr');
  const side = Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.94);
  const c = qrCanvas(code, side * Math.min(2, window.devicePixelRatio || 1));
  c.style.width = c.style.height = `${side}px`;
  back.append(c);
  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    back.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  back.addEventListener('click', close);
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
}

/** Помилка камери (getUserMedia) — українською. */
function cameraError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Немає дозволу на камеру';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Камеру не знайдено';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Камера зайнята іншою програмою';
  return 'Камера недоступна';
}

async function sendCode(area: HTMLTextAreaElement, share: boolean): Promise<void> {
  const text = area.value;
  if (!text) return;
  if (share) {
    await navigator.share({ text }).catch(() => {});
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    area.focus();
    area.select();
    document.execCommand('copy');
  }
}

/**
 * «Мережева гра» другої гри: екрани оригіналу з LOAD.RES — вибір машини `n/backMult` (марка стрілками, колір,
 * «Сервер» / «Клиент») і екран сервера `h/backHost` (траса, складність, повзунки; re/notes/ht2/tracks.md §2). Сама
 * мережа — власна (net/, як у першій грі): WebRTC у локальній Wi-Fi, коди з'єднання QR-кодом чи текстом, до 8
 * гравців «зіркою» через господаря. Панель кодів і списку гравців — порту (в оригіналі DirectPlay, такого екрана
 * немає): лежить у колі екрана сервера над його кнопками; «Далее» оригіналу — старт, «Отмена» — назад.
 */
import { DEFAULT_SETUP, NetPeer, type CloseReason, type NetCar, type NetPlayer, type NetSetup, type NetTrack } from '../net/peer';
import { MAX_PLAYERS, NetSession } from '../net/session';
import { PLAYER_COLORS } from '../net/state';
import { QrScanner, cameraAvailable, qrCanvas } from '../net/qr';
import { modal } from '../engine/ui/modal';
import { screen, texButton, type Ht2MenuArt, type RoundKey } from './menu';

/** Скільки чекати з'єднання після обміну кодами, мс. */
const CONNECT_TIMEOUT = 15000;
/** Місць на решітці (суперники господаря — на вільних, як `aitruck 8` у MENV/GAME.CNF). */
const GRID = 8;

const CLOSE_TEXT: Record<CloseReason, string> = {
  bye: 'Друг вийшов із гри.',
  lost: 'Зв’язок із другом втрачено.',
  failed: 'Не вдалося з’єднатися: телефони мають бути в одній Wi-Fi мережі.',
  version: 'У друга інша версія гри — оновіть обидва телефони.',
  local: '',
};

/**
 * Машини екрана «Мережева гра»: картинки `n/<марка><колір>.msk` (4 кольори) → car_node. Відповідність — з таблиць
 * king.exe поруч із цими назвами (0x275fe4…0x2761b4: `ZilR`, `KamazR`… і `Mack`, `Kenw`, `Frei`, `Peter` — тягачі):
 * де є вантажівка `…R` — вона (гонка без причепа), тягачі — Mack, Kenworth, Freightliner, Peterbilt, International;
 * легкові — BmwM5, Patrol, Sobol, Gazelle [гіпотеза за назвами]. Порядок — як у ресурсах; типово — RenaultR
 * (`live 1 "RenaultR"` у MENV/GAME.CNF).
 */
export const NET_CARS: { brand: string; truck: string; name: string }[] = [
  { brand: 'bmw', truck: 'BmwM5', name: 'BMW M5' },
  { brand: 'daf', truck: 'DafR', name: 'DAF' },
  { brand: 'frei', truck: 'Freightliner', name: 'Freightliner' },
  { brand: 'gaz', truck: 'Gazelle', name: 'ГАЗель' },
  { brand: 'inter', truck: 'International', name: 'International' },
  { brand: 'kamaz', truck: 'KamazR', name: 'КамАЗ' },
  { brand: 'kenw', truck: 'Kenworth', name: 'Kenworth' },
  { brand: 'mack', truck: 'Mack', name: 'Mack' },
  { brand: 'mers', truck: 'MercedesR', name: 'Mercedes' },
  { brand: 'patrol', truck: 'Patrol', name: 'Nissan Patrol' },
  { brand: 'peter', truck: 'Peterbilt', name: 'Peterbilt' },
  { brand: 'reno', truck: 'RenaultR', name: 'Renault' },
  { brand: 'scania', truck: 'ScaniaR', name: 'Scania' },
  { brand: 'sobol', truck: 'Sobol', name: 'Соболь' },
  { brand: 'storm', truck: 'StormR', name: 'Storm' },
  { brand: 'volvo', truck: 'VolvoR', name: 'Volvo' },
  { brand: 'zil', truck: 'ZilR', name: 'ЗіЛ' },
];
export const DEFAULT_CAR: NetCar = { truck: 'RenaultR', color: 0 };

export function carName(truck: string): string {
  return NET_CARS.find((c) => c.truck === truck)?.name ?? truck;
}

const TRACK_NAME: Record<NetTrack, string> = { ring: 'Кільце', trial: 'Тріал', ball: 'Автобол' };

/** Початок заїзду: сесія, вибір господаря, гравці з машинами, машини суперників (номери від FIRST_RIVAL). */
export interface NetStart {
  session: NetSession;
  setup: NetSetup;
  players: NetPlayer[];
  rivals: NetCar[];
}

/**
 * Суперники господаря (перед стартом): на вільні місця решітки — вантажівки й тягачі, яких немає в гравців (без
 * легкових і Storm — довгий для решітки), кольори по колу.
 */
function pickRivals(session: NetSession): NetCar[] {
  const taken = new Set([...session.players.values()].map((p) => p.truck));
  const pool = NET_CARS.filter((c) => !['BmwM5', 'Patrol', 'Sobol', 'Gazelle', 'StormR'].includes(c.truck));
  const free = pool.filter((c) => !taken.has(c.truck));
  const from = free.length ? free : pool;
  return Array.from({ length: Math.max(0, GRID - session.players.size) }, (_, i) => ({ truck: from[(i * 5) % from.length].truck, color: i % 4 }));
}

export interface NetMenuOptions {
  driver: string;
  /** Машина з минулого разу. */
  car: NetCar;
  /** Повернення із заїзду до тієї ж сесії. */
  from?: NetSession | null;
  /** Машину змінено — зберегти вибір. */
  onCar?(car: NetCar): void;
}

/**
 * Розділ «Мережева гра»: вибір машини → «Сервер» (вибір траси) чи «Клиент» → обмін кодами → сесія. Результат —
 * початок заїзду, кругла кнопка рамки (інший розділ меню) чи null (головне меню).
 */
export async function ht2NetMenu(art: Ht2MenuArt, o: NetMenuOptions): Promise<NetStart | RoundKey | null> {
  let note: string | null = null;
  let session = o.from ?? null;
  const car: NetCar = { ...(session?.me ?? o.car) };
  for (;;) {
    if (!session || session.closed) {
      const r = await multScreen(art, car, note, (c) => o.onCar?.(c));
      note = null;
      if (r === null || (r !== 'host' && r !== 'join')) return r;
      if (r === 'host') {
        const setup = await hostScreen(art, { ...DEFAULT_SETUP });
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
    const r = await sessionPanel(art, o.driver, session);
    if (r === 'add') {
      // Господар додає гравця: гості чекають у сесії (її веде сама сесія).
      session.events = {};
      const peer = await connectPanel(art, o.driver, 'host', true);
      if (peer && !session.closed) session.addGuest(peer);
      else peer?.close();
      continue;
    }
    if (r === 'setup') {
      session.events = {};
      const s = await hostScreen(art, session.setup);
      if (s && !session.closed) session.setSetup(s);
      continue;
    }
    if (r && typeof r === 'object') return r;
    note = r;
    session = null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

/** Елемент у точці (x, y) сцени 800×600 розміром w×h. */
function place<T extends HTMLElement>(stage: HTMLElement, e: T, x: number, y: number, w: number, h: number): T {
  e.classList.add('menu-abs');
  Object.assign(e.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  stage.append(e);
  return e;
}

/**
 * Екран «Мережева гра» (n/backMult; місця — king.exe 0x51a580, збігаються з гніздами фону): марка в колі
 * (`n/<марка><колір>.msk` 160×160), стрілки `aleft`/`aright`, «Цвет», «Сервер», «Клиент», «Отмена». У полі
 * «Способы соединения» — підказка порту (з'єднання — Wi-Fi, коди QR).
 */
function multScreen(art: Ht2MenuArt, car: NetCar, note: string | null, onCar: (c: NetCar) => void): Promise<'host' | 'join' | RoundKey | null> {
  return new Promise((resolve) => {
    const done = (v: 'host' | 'join' | RoundKey | null) => {
      sc.close();
      resolve(v);
    };
    const sc = screen(art, 'n/backmult.txr', (k) => {
      if (k !== 'multi') done(k);
    });
    const { stage } = sc;
    let i = Math.max(0, NET_CARS.findIndex((c) => c.truck === car.truck));
    const pic = place(stage, el('img', 'ht2-net-car'), 360, 135, 160, 160) as HTMLImageElement;
    pic.alt = '';
    pic.draggable = false;
    const label = place(stage, el('div', 'ht2-net-carname'), 340, 98, 200, 22);
    const info = place(stage, el('div', 'ht2-net-conn'), 368, 366, 206, 52);
    const paint = () => {
      const c = NET_CARS[i];
      pic.src = art.image(`n/${c.brand}${car.color}.msk`) ?? '';
      label.textContent = c.name;
      Object.assign(car, { truck: c.truck });
      onCar({ ...car });
    };
    const step = (d: number) => () => {
      i = (i + d + NET_CARS.length) % NET_CARS.length;
      paint();
    };
    texButton(art, stage, 'aleft', 323, 200, 'Попередня машина', { ext: '.msk', action: step(-1) });
    texButton(art, stage, 'aright', 528, 200, 'Наступна машина', { ext: '.msk', action: step(1) });
    texButton(art, stage, 'n/color', 390, 303, 'Колір', {
      action: () => {
        car.color = (car.color + 1) % 4;
        paint();
      },
    });
    texButton(art, stage, 'n/host', 348, 428, 'Сервер — створити гру', { action: () => done('host') });
    texButton(art, stage, 'n/join', 451, 428, 'Клієнт — приєднатися', { action: () => done('join') });
    texButton(art, stage, 'n/cancel', 323, 488, 'Скасувати', { action: () => done(null) });
    info.textContent = note ?? 'Wi-Fi, одна мережа: коди з’єднання — QR-кодом або текстом. СЕРВЕР — створити гру, КЛІЄНТ — приєднатися.';
    info.classList.toggle('note', !!note);
    paint();
  });
}

/**
 * Екран сервера (h/backHost, king.exe 0x51add0): траса КОЛЬЦО / ТРИАЛ / АВТОБОЛ (радіо), аркада / симулятор,
 * повзунки «Насыщенность трасс», «Длительность суток», «Погода» (aleft/aright/runner, ширина 187), «Далее»,
 * «Отмена». Результат — вибір (null — скасовано).
 */
function hostScreen(art: Ht2MenuArt, from: NetSetup): Promise<NetSetup | null> {
  return new Promise((resolve) => {
    const s = { ...from };
    const done = (v: NetSetup | null) => {
      sc.close();
      resolve(v);
    };
    const sc = screen(art, 'h/backhost.txr');
    const { stage, root } = sc;
    const painters: (() => void)[] = [];
    const repaint = () => painters.forEach((p) => p());
    const track = (key: NetTrack, tex: string, x: number, label: string) =>
      painters.push(
        texButton(art, stage, `h/${tex}`, x, 202, label, {
          selected: () => s.track === key,
          action: () => {
            // Автобол — арена MTB, у порті ще не зроблений.
            if (key === 'ball') return void modal(root, 'Мережева гра', `${TRACK_NAME[key]} — у наступних кроках порту. Поки що — Кільце й Тріал.`, ['Гаразд']);
            s.track = key;
          },
          after: repaint,
        }),
      );
    track('ring', 'circ', 324, 'Кільце');
    track('trial', 'trial', 402, 'Тріал');
    track('ball', 'tball', 473, 'Автобол');
    painters.push(
      texButton(art, stage, 'h/arcad', 348, 254, 'Аркадний', { selected: () => s.arcade, action: () => (s.arcade = true), after: repaint }),
      texButton(art, stage, 'h/simul', 450, 254, 'Симулятор', { selected: () => !s.arcade, action: () => (s.arcade = false), after: repaint }),
    );
    // Повзунки: ліва стрілка в (356, y), права — на x + 187 − 29; бігунок між ними (як на екрані одиночної гри).
    const sliders: [keyof Pick<NetSetup, 'traffic' | 'dayLength' | 'weather'>, number, string][] = [
      ['traffic', 306, 'Насиченість трас'],
      ['dayLength', 336, 'Тривалість доби'],
      ['weather', 366, 'Погода'],
    ];
    const RUN_X0 = 391;
    const RUN_X1 = 509;
    for (const [key, y, label] of sliders) {
      const set = (v: number) => {
        s[key] = Math.round(Math.min(1, Math.max(0, v)) * 10) / 10;
        repaint();
      };
      painters.push(
        texButton(art, stage, 'aleft', 356, y, `${label}: менше`, { ext: '.msk', disabled: () => s[key] <= 0, action: () => set(s[key] - 0.1) }),
        texButton(art, stage, 'aright', 514, y, `${label}: більше`, { ext: '.msk', disabled: () => s[key] >= 1, action: () => set(s[key] + 0.1) }),
      );
      const bar = el('div', 'ht2-track');
      place(stage, bar, RUN_X0 - 8, y + 1, RUN_X1 - RUN_X0 + 16, 26);
      bar.style.height = '';
      const knob = el('img', 'ht2-runner') as HTMLImageElement;
      knob.alt = '';
      knob.draggable = false;
      bar.append(knob);
      let drag = false;
      const paint = () => {
        knob.src = art.image(`runner_${drag ? 'ap' : 'p'}.msk`) ?? '';
        knob.style.left = `${8 + (RUN_X1 - RUN_X0) * s[key] - 6}px`;
      };
      const fromEvent = (e: PointerEvent) => {
        const r = bar.getBoundingClientRect();
        const k = r.width / (RUN_X1 - RUN_X0 + 16);
        set((e.clientX - r.left - 8 * k) / ((RUN_X1 - RUN_X0) * k));
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
      painters.push(paint);
    }
    texButton(art, stage, 'h/next', 372, 412, 'Далі', { action: () => done(s) });
    texButton(art, stage, 'h/cancel', 323, 477, 'Скасувати', { action: () => done(null) });
    repaint();
  });
}

/**
 * Панель порту в колі екрана сервера (над трасою й повзунками, до кнопки «Далее»): x 316…646, y 116…404.
 * Фон — h/backHost (кнопки оригіналу поза панеллю лишаються: «Далее», «Отмена»).
 */
const PANEL = [316, 116, 330, 288] as const;

function panelScreen(art: Ht2MenuArt): { stage: HTMLElement; root: HTMLElement; panel: HTMLElement; close: () => void } {
  const sc = screen(art, 'h/backhost.txr');
  const panel = place(sc.stage, el('div', 'ht2-net-panel'), ...PANEL);
  return { ...sc, panel };
}

/**
 * Обмін кодами з'єднання (як у першій грі): господар — QR-код запрошення, камера чекає відповідь друга; гість — камера
 * сканує запрошення, далі QR-код відповіді. «Код текстом» — ті самі коди текстом (без камери: dev-сервер без HTTPS,
 * ПК; або надіслати месенджером). Результат — з'єднаний друг (null — назад).
 */
function connectPanel(art: Ht2MenuArt, driver: string, mode: 'host' | 'join', adding: boolean): Promise<NetPeer | null> {
  return new Promise((resolve) => {
    const sc = panelScreen(art);
    const { panel } = sc;
    const head = el('div', 'ht2-net-head');
    head.textContent = mode === 'host' ? (adding ? 'НОВИЙ ГРАВЕЦЬ' : 'СТВОРИТИ ГРУ') : 'ПРИЄДНАТИСЯ';
    const body = el('div', 'ht2-net-body');
    const qrBox = el('div', 'ht2-net-qr');
    const right = el('div', 'ht2-net-right');
    const video = el('video', 'ht2-net-video');
    video.muted = true;
    video.playsInline = true;
    const codes = el('div', 'ht2-net-codes');
    const ownLabel = el('div', '');
    ownLabel.textContent = 'Ваш код:';
    const own = el('textarea', 'ht2-net-code');
    own.readOnly = true;
    own.addEventListener('focus', () => own.select());
    const send = el('button', 'ht2-net-link');
    const share = typeof navigator.share === 'function';
    send.textContent = share ? 'Надіслати' : 'Копіювати';
    send.addEventListener('click', () => void sendCode(own, share));
    const friendLabel = el('div', '');
    friendLabel.textContent = 'Код друга:';
    const friend = el('textarea', 'ht2-net-code');
    friend.placeholder = 'вставте код';
    friend.addEventListener('input', () => {
      const v = friend.value.replace(/\s+/g, '').toUpperCase();
      if (v.startsWith('HT2:') && v.length > 60) void gotCode(v);
    });
    codes.append(ownLabel, own, send, friendLabel, friend);
    right.append(video, codes);
    body.append(qrBox, right);
    const status = el('div', 'ht2-net-status');
    const toggle = el('button', 'ht2-net-button');
    panel.append(head, body, status, toggle);

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
      toggle.textContent = textMode ? 'КАМЕРА' : 'КОД ТЕКСТОМ';
      updateScan();
    };
    toggle.addEventListener('click', () => {
      textMode = !textMode;
      layout();
    });
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
      sc.close();
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
    texButton(art, sc.stage, 'h/cancel', 323, 477, 'Назад', { action: () => done(null) });
    if (mode === 'host') void startHost();
    else {
      say(textMode ? 'Вставте код друга, що створив гру.' : 'Наведіть камеру на QR-код друга, що створив гру.');
      layout();
    }
  });
}

/**
 * Сесія: гравці (до 8) з машинами, кольором і затримкою; господар додає гравців («+ Гравець» — обмін кодами з
 * наступним гостем), змінює вибір («Траса»), «Далее» — старт (усі вантажать трасу), «Отмена» — закрити з'єднання.
 * Результат — початок заїзду, 'add', 'setup' чи причина закриття для екрана вибору (null — вийшли самі).
 */
function sessionPanel(art: Ht2MenuArt, driver: string, session: NetSession): Promise<NetStart | 'add' | 'setup' | string | null> {
  return new Promise((resolve) => {
    const sc = panelScreen(art);
    const { panel } = sc;
    const host = session.host;
    const head = el('div', 'ht2-net-head');
    const list = el('div', 'ht2-net-players');
    const setupLine = el('div', 'ht2-net-setup');
    const row = el('div', 'ht2-net-row');
    const foot = el('div', 'ht2-net-status');
    panel.append(head, list, setupLine, row, foot);
    const button = (text: string, click: () => void) => {
      const b = el('button', 'ht2-net-button');
      b.textContent = text;
      b.addEventListener('click', click);
      row.append(b);
      return b;
    };
    const add = host ? button('+ ГРАВЕЦЬ', () => done('add')) : null;
    if (host) button('ТРАСА', () => done('setup'));
    const renderList = () => {
      head.textContent = `МЕРЕЖЕВА ГРА · ${session.players.size} з ${MAX_PLAYERS}`;
      list.replaceChildren(
        ...[...session.players.values()]
          .sort((a, b) => a.id - b.id)
          .map((p) => {
            const line = el('div', p.id === session.myId ? 'me' : '');
            const sq = el('i', '');
            sq.style.background = PLAYER_COLORS[p.id] ?? '#fff';
            const ms = p.id === session.myId || (!host && p.id !== 0) ? null : session.rtt(p.id);
            const who = p.id === session.myId ? driver : p.name;
            const span = el('span', '');
            span.textContent = `${p.id + 1}. ${who}${p.id === 0 ? ' (сервер)' : ''} — ${carName(p.truck)}${p.driving && p.id !== session.myId ? ' (на трасі)' : ''}${ms !== null ? ` · ${Math.round(ms)} мс` : ''}`;
            line.append(sq, span);
            return line;
          }),
      );
    };
    const render = () => {
      renderList();
      const s = session.setup;
      setupLine.textContent = `Траса: ${TRACK_NAME[s.track]} · ${s.arcade ? 'аркада' : 'симулятор'}`;
      if (add) add.hidden = session.full;
      foot.textContent = host
        ? session.players.size > 1
          ? 'ДАЛІ — старт: усі завантажать трасу разом з вами. Суперники займуть вільні місця.'
          : 'Додайте гравця (+ ГРАВЕЦЬ), щоб почати гру.'
        : 'Трасу обирає сервер. Чекаємо, поки він натисне ДАЛІ.';
    };
    const timer = window.setInterval(renderList, 1000);
    const done = (v: NetStart | 'add' | 'setup' | string | null) => {
      clearInterval(timer);
      session.events = {};
      sc.close();
      resolve(v);
    };
    session.events = {
      onChange: render,
      onMessage: (m) => {
        if (m.t === 'start') done({ session, setup: m.setup, players: m.players, rivals: m.rivals });
        else render();
      },
      onLeave: (id, reason) => {
        if (id === 0) return done(reason === 'bye' ? 'Сервер вийшов з гри.' : CLOSE_TEXT[reason] || null);
        render();
      },
    };
    const leave = () => {
      session.close();
      done(null);
    };
    if (host)
      texButton(art, sc.stage, 'h/next', 372, 412, 'Далі — старт', {
        action: () => {
          if (session.players.size < 2) return;
          const m = session.start(pickRivals(session));
          done({ session, setup: m.setup, players: m.players, rivals: m.rivals });
        },
      });
    texButton(art, sc.stage, 'h/cancel', 323, 477, 'Вийти з гри', { action: leave });
    // Повернення із заїзду — інші мають знати (у них машина зникає, у сесії — не «на трасі»).
    if (session.me.driving) session.backToLobby();
    render();
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

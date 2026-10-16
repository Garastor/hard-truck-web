/**
 * «Мережева гра» — екрани мережевої гри оригіналу з LOAD.RES: «Способи з'єднання» (c/back_con) і сесія
 * (s/back_net). Сама мережа — власна (net/): гра на 2–4 гравців через Wi-Fi, коди з'єднання — QR чи текстом.
 * Рамки кнопок (зіставлення масок із фоном, як для інших екранів): c/change (21,326), c/client (327,326),
 * c/2main (21,389), c/server (327,389); s/cancel і s/start — одна рамка (489,17). Панелі: c — x 21…439,
 * y 113…311 (заголовок праворуч угорі, y 120…128); s — x 19…456, y 17…454.
 */
import type { MenuArt } from '../engine/ui/menuArt';
import { TRACKS } from '../career/career';
import { NetPeer, type CloseReason, type NetPlayer } from '../net/peer';
import { NetSession } from '../net/session';
import { QrScanner, cameraAvailable, qrCanvas } from '../net/qr';
import { maskButton, Screen } from './menuScreens';

/** Скільки чекати з'єднання після обміну кодами, мс. */
const CONNECT_TIMEOUT = 15000;

const CLOSE_TEXT: Record<CloseReason, string> = {
  bye: 'Друг вийшов із гри.',
  lost: 'Зв’язок із другом втрачено.',
  failed: 'Не вдалося з’єднатися: телефони мають бути в одній Wi-Fi мережі.',
  version: 'У друга інша версія гри — оновіть обидва телефони.',
  local: '',
};

/** Траси мережевої гри (як у кар'єрі). */
const NET_TRACKS: [string, string][] = Object.entries(TRACKS).map(([id, t]) => [id, t.title]);

/** Вантажівка для вибору: номер у TRUCK.TCH і назва. */
export interface NetTruck {
  index: number;
  name: string;
}

/** Початок заїзду: сесія, траса, погода, гравці з вантажівками (на момент старту), вантажівки суперників. */
export interface NetStart {
  session: NetSession;
  level: string;
  rain: boolean;
  players: NetPlayer[];
  /** Вантажівки суперників (номери в TRUCK.TCH), по порядку — номери машин від FIRST_RIVAL. */
  rivals: number[];
}

/**
 * Вантажівки суперників (господар, перед стартом): інші моделі, ніж у гравців, по колу; Полігон — без суперників
 * (заїзд поодинці, як у тестовому режимі).
 */
function pickRivals(session: NetSession, trucks: NetTruck[]): number[] {
  if (session.level === 'TRIAL') return [];
  const taken = new Set([...session.players.values()].map((p) => p.truck));
  const pool = trucks.filter((t) => !taken.has(t.index));
  const from = pool.length ? pool : trucks;
  return Array.from({ length: session.rivals }, (_, i) => from[i % from.length].index);
}

/**
 * Розділ «Мережева гра»: з'єднання → сесія (господар додає гостей по одному, до MAX_PLAYERS). Результат — початок
 * заїзду (null — головне меню). from — повернення із заїзду до тієї ж сесії.
 */
export async function netMenu(art: MenuArt, driver: string, trucks: NetTruck[], from: NetSession | null = null): Promise<NetStart | null> {
  let note: string | null = null;
  let session = from;
  let truck = from?.me.truck ?? (trucks.some((t) => t.index === 1) ? 1 : (trucks[0]?.index ?? 1));
  for (;;) {
    if (!session || session.closed) {
      const c = await connectScreen(art, driver, note, false);
      if (!c) return null;
      note = null;
      if (c.host) {
        session = NetSession.hostFor(driver, truck);
        session.addGuest(c.peer);
      } else {
        try {
          session = await NetSession.join(c.peer, driver, truck);
        } catch (e) {
          note = e instanceof Error ? e.message : String(e);
          session = null;
          continue;
        }
      }
    }
    const r = await sessionScreen(art, driver, session, trucks);
    truck = session.me.truck;
    if (r === 'add') {
      // Господар додає гравця: гості чекають у сесії (її веде сама сесія).
      session.events = {};
      const c = await connectScreen(art, driver, null, true);
      if (c && !session.closed) session.addGuest(c.peer);
      else c?.peer.close();
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

/**
 * «Способи з'єднання»: СТВОРИТИ ГРУ — QR-код запрошення ліворуч, камера праворуч чекає відповідь друга;
 * ПРИЄДНАТИСЯ — камера сканує запрошення, далі QR-код відповіді. КОД ТЕКСТОМ — ті самі коди текстом (без камери:
 * dev-сервер без HTTPS, ПК; або надіслати месенджером). Результат — з'єднаний друг і чи ми господар (null —
 * головне меню). adding — господар додає ще одного гравця до сесії: одразу запрошення, «Головне меню» — назад до сесії.
 */
function connectScreen(art: MenuArt, driver: string, note: string | null, adding: boolean): Promise<{ peer: NetPeer; host: boolean } | null> {
  return new Promise((resolve) => {
    const scr = new Screen(art, 'c/back_con.txr');
    const info = scr.place(el('div', 'net-text'), 28, 134, 404, 172);
    const qrBox = scr.place(el('div', 'net-qr'), 28, 122, 182, 182);
    const video = scr.place(el('video', 'net-video'), 240, 134, 176, 132);
    const status = scr.place(el('div', 'net-text net-status'), 220, 270, 214, 38);
    // Коди текстом — на місці камери.
    const textBox = scr.place(el('div', 'net-codes'), 220, 132, 214, 136);
    const ownLabel = el('div', 'net-label');
    ownLabel.textContent = 'Ваш код:';
    const own = el('textarea', 'net-code');
    own.readOnly = true;
    own.rows = 2;
    own.addEventListener('focus', () => own.select());
    const send = el('button', 'net-link');
    const share = typeof navigator.share === 'function';
    send.textContent = share ? 'Надіслати' : 'Копіювати';
    send.addEventListener('click', () => void sendCode(own, share));
    const friendLabel = el('div', 'net-label');
    friendLabel.textContent = 'Код друга:';
    const friend = el('textarea', 'net-code');
    friend.rows = 2;
    friend.placeholder = 'вставте код';
    friend.addEventListener('input', () => {
      const v = friend.value.replace(/\s+/g, '').toUpperCase();
      if (v.startsWith('HT1:') && v.length > 60) void gotCode(v);
    });
    textBox.append(ownLabel, own, send, friendLabel, friend);

    const camera = cameraAvailable();
    let textMode = !camera;
    let mode: 'idle' | 'host' | 'join' = 'idle';
    let peer: NetPeer | null = null;
    let scanner: QrScanner | null = null;
    /** Лічильник дій: відповідь застарілої дії (гравець уже натиснув інше) відкидається. */
    let action = 0;
    let busy = false;
    let lastBad = '';
    let timeout = 0;

    const say = (text: string) => (status.textContent = text);
    const needScan = () => (mode === 'host' && !!peer && !busy) || (mode === 'join' && !peer && !busy);
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
      info.hidden = mode !== 'idle';
      qrBox.hidden = mode === 'idle' || !qrBox.firstChild;
      video.hidden = mode === 'idle' || textMode || !needScan();
      textBox.hidden = mode === 'idle' || !textMode;
      status.hidden = mode === 'idle';
      friend.disabled = !needScan();
      sel.forEach((b) => b.refresh());
      updateScan();
    };
    const showCode = (code: string) => {
      qrBox.replaceChildren(qrCanvas(code, 182));
      own.value = code;
    };
    // Дотик до QR-коду — на весь екран (більші клітинки — камера друга читає з більшої відстані); ще дотик — назад.
    qrBox.title = 'Торкніться — більше';
    qrBox.addEventListener('click', () => {
      if (own.value) showBigQr(own.value);
    });
    const drop = () => {
      action++;
      clearTimeout(timeout);
      peer?.close();
      peer = null;
      busy = false;
      lastBad = '';
      qrBox.replaceChildren();
      own.value = '';
      friend.value = '';
    };
    const done = (v: NetPeer | null) => {
      clearTimeout(timeout);
      scanner?.stop();
      scanner = null;
      if (!v) peer?.close();
      scr.close();
      resolve(v ? { peer: v, host: mode === 'host' } : null);
    };
    const watch = (p: NetPeer) => {
      p.events = {
        onReady: () => done(p),
        onClose: (reason) => {
          if (p !== peer) return;
          peer = null;
          busy = false;
          if (reason !== 'local') say(CLOSE_TEXT[reason] || 'З’єднання закрито.');
          layout();
        },
      };
    };
    const connecting = () => {
      say('З’єднуємо…');
      timeout = window.setTimeout(() => {
        say('Не з’єднується. Перевірте, що обидва телефони в одній Wi-Fi мережі, і спробуйте ще раз.');
      }, CONNECT_TIMEOUT);
    };

    const startHost = async () => {
      drop();
      const my = action;
      mode = 'host';
      busy = true;
      say('Готуємо запрошення…');
      layout();
      try {
        const r = await NetPeer.host(driver);
        if (my !== action) return r.peer.close();
        peer = r.peer;
        watch(peer);
        showCode(r.code);
        busy = false;
        say(textMode ? 'Надішліть код другу й вставте його відповідь.' : 'Покажіть код другу, потім наведіть камеру на його відповідь.');
      } catch (e) {
        if (my === action) say(`Помилка: ${e instanceof Error ? e.message : String(e)}`);
        busy = false;
      }
      layout();
    };
    const startJoin = () => {
      drop();
      mode = 'join';
      say(textMode ? 'Вставте код друга, що створив гру.' : 'Наведіть камеру на QR-код друга, що створив гру.');
      layout();
    };
    /** Розпізнаний код (камера чи текст): для господаря — відповідь друга, для гостя — запрошення. */
    const gotCode = async (code: string) => {
      if (busy || code === lastBad || !needScan()) return;
      const my = action;
      busy = true;
      layout();
      try {
        if (mode === 'host' && peer) {
          await peer.accept(code);
          if (my !== action) return;
          connecting();
        } else if (mode === 'join') {
          say('Готуємо відповідь…');
          const r = await NetPeer.join(driver, code);
          if (my !== action) return r.peer.close();
          peer = r.peer;
          watch(peer);
          showCode(r.code);
          say(textMode ? 'Надішліть цей код другу.' : 'Покажіть цей код другу.');
          connecting();
        }
      } catch (e) {
        if (my !== action) return;
        lastBad = code;
        busy = false;
        say(e instanceof Error ? e.message : String(e));
      }
      layout();
    };

    const sel = [
      maskButton(scr, art, 'c/server', 327, 389, () => void startHost(), { selected: () => mode === 'host' }),
      maskButton(scr, art, 'c/client', 327, 326, startJoin, { selected: () => mode === 'join', disabled: adding }),
      maskButton(scr, art, 'c/change', 21, 326, () => ((textMode = camera ? !textMode : true), layout()), { selected: () => textMode }),
    ];
    maskButton(scr, art, 'c/2main', 21, 389, () => done(null));
    scr.keys(null, () => done(null));

    info.innerHTML = `<p>Гра вдвох, утрьох чи вчотирьох по Wi-Fi — телефони мають бути в одній мережі. Кожен гість обмінюється кодами з тим, хто створив гру.</p>
      <p><b>СТВОРИТИ ГРУ</b> — покажіть QR-код другу (дотик — на весь екран) і відскануйте його відповідь.</p>
      <p><b>ПРИЄДНАТИСЯ</b> — відскануйте QR-код друга й покажіть йому свій.</p>
      <p><b>КОД ТЕКСТОМ</b> — ті самі коди текстом: надіслати месенджером${camera ? '' : ' (камера тут недоступна — потрібен HTTPS)'}.</p>`;
    if (note) {
      const p = el('p', 'net-note');
      p.textContent = note;
      info.prepend(p);
    }
    layout();
    // Ще один гравець до сесії — одразу запрошення.
    if (adding) void startHost();
  });
}

/**
 * Сесія (s/back_net): гравці (до MAX_PLAYERS) з вантажівками й затримкою; господар обирає трасу, погоду й
 * суперників і додає гравців («+ Додати гравця» — обмін кодами з наступним гостем), кожен — свою вантажівку.
 * СТАРТ (господар) — усі вантажать трасу; ВИЙТИ — закрити з'єднання. Результат — початок заїзду, 'add' (додати
 * гравця) або причина закриття для екрана з'єднання (null — вийшли самі).
 */
function sessionScreen(art: MenuArt, driver: string, session: NetSession, trucks: NetTruck[]): Promise<NetStart | 'add' | string | null> {
  return new Promise((resolve) => {
    const scr = new Screen(art, 's/back_net.txr');
    const box = scr.place(el('div', 'net-text net-session'), 34, 30, 408, 410);
    const head = el('div', '');
    const addRow = el('div', 'net-chips');
    const levelRow = el('div', 'net-chips');
    const weatherRow = el('div', 'net-chips');
    const truckRow = el('div', 'net-chips net-trucks');
    const foot = el('p', 'net-note');
    const label = (text: string) => {
      const p = el('div', 'net-label');
      p.textContent = text;
      return p;
    };
    box.append(head, addRow, label('ТРАСА'), levelRow, label('ПОГОДА · СУПЕРНИКИ'), weatherRow, label('ВАША ВАНТАЖІВКА'), truckRow, foot);
    const host = session.host;
    const nameOf = (i: number) => trucks.find((t) => t.index === i)?.name ?? `№${i}`;
    const chip = (row: HTMLElement, text: string, on: boolean, enabled: boolean, click: () => void) => {
      const b = el('button', `net-chip${on ? ' on' : ''}`);
      b.textContent = text;
      b.disabled = !enabled;
      b.addEventListener('click', click);
      row.append(b);
    };
    const renderHead = () => {
      const rows = [...session.players.values()]
        .sort((a, b) => a.id - b.id)
        .map((p) => {
          const who = `${p.id === session.myId ? driver : p.name}${p.id === 0 ? ' (створив гру)' : ''}${p.id === session.myId ? ' — ви' : ''}`;
          // Затримка: у господаря — до кожного гостя, у гостя — до господаря.
          const ms = p.id === session.myId || (!host && p.id !== 0) ? null : session.rtt(p.id);
          const extra = `${p.driving && p.id !== session.myId ? ' (на трасі)' : ''}${ms !== null ? ` · ${Math.round(ms)} мс` : ''}`;
          return `<p class="net-player">${p.id + 1}. ${escapeHtml(who)} — ${escapeHtml(nameOf(p.truck))}${extra}</p>`;
        });
      head.innerHTML = `<h3>МЕРЕЖЕВА ГРА</h3>${rows.join('')}`;
    };
    const render = () => {
      renderHead();
      addRow.replaceChildren();
      if (host && !session.full) chip(addRow, '+ Додати гравця', false, true, () => done('add'));
      levelRow.replaceChildren();
      for (const [id, title] of NET_TRACKS) chip(levelRow, title, session.level === id, host, () => session.setSetup(id, session.rain, session.rivals));
      weatherRow.replaceChildren();
      for (const [rain, title] of [[false, 'Сухо'], [true, 'Дощ']] as const) chip(weatherRow, title, session.rain === rain, host, () => session.setSetup(session.level, rain, session.rivals));
      // Суперники (0…7, як у новій грі оригіналу) — у тому ж рядку, після відступу.
      weatherRow.append(el('span', 'net-gap'));
      for (let n = 0; n <= 7; n++) chip(weatherRow, String(n), session.rivals === n, host, () => session.setSetup(session.level, session.rain, n));
      truckRow.replaceChildren();
      for (const t of trucks) chip(truckRow, t.name, session.me.truck === t.index, true, () => session.pickTruck(t.index));
      foot.textContent = host
        ? session.players.size > 1
          ? 'Оберіть трасу й натисніть СТАРТ — усі завантажать її разом з вами.'
          : 'Додайте гравця, щоб почати гру.'
        : 'Трасу й погоду обирає той, хто створив гру. Чекаємо, поки він натисне СТАРТ.';
    };
    const timer = window.setInterval(renderHead, 1000);
    const done = (v: NetStart | 'add' | string | null) => {
      clearInterval(timer);
      session.events = {};
      scr.close();
      resolve(v);
    };
    session.events = {
      onChange: render,
      onMessage: (m) => {
        if (m.t === 'start') done({ session, level: m.level, rain: m.rain, players: m.players, rivals: m.rivals });
        else render();
      },
      onLeave: (id, reason) => {
        if (id === 0) return done(reason === 'bye' ? 'Той, хто створив гру, вийшов.' : CLOSE_TEXT[reason] || null);
        render();
      },
    };
    const leave = () => {
      session.close();
      done(null);
    };
    if (host) {
      maskButton(scr, art, 's/start', 489, 17, () => {
        if (session.players.size < 2) return;
        const m = session.start(pickRivals(session, trucks));
        done({ session, level: m.level, rain: m.rain, players: m.players, rivals: m.rivals });
      });
      maskButton(scr, art, 's/cancel', 489, 77, leave);
    } else maskButton(scr, art, 's/cancel', 489, 17, leave);
    scr.keys(null, leave);
    // Повернення із заїзду — інші мають знати (у них машина зникає, у сесії — не «на трасі»).
    if (session.me.driving) session.backToLobby();
    render();
  });
}

/** QR-код на весь екран (найбільший квадрат вікна), дотик чи Esc — закрити. */
function showBigQr(code: string): void {
  const back = el('div', 'net-bigqr');
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

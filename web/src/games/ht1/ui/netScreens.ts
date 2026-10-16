/**
 * «Мережева гра» — екрани мережевої гри оригіналу з LOAD.RES: «Способи з'єднання» (c/back_con) і сесія
 * (s/back_net). Сама мережа — власна (net/): гра вдвох через Wi-Fi, коди з'єднання — QR чи текстом.
 * Рамки кнопок (зіставлення масок із фоном, як для інших екранів): c/change (21,326), c/client (327,326),
 * c/2main (21,389), c/server (327,389); s/cancel і s/start — одна рамка (489,17). Панелі: c — x 21…439,
 * y 113…311 (заголовок праворуч угорі, y 120…128); s — x 19…456, y 17…454.
 */
import type { MenuArt } from '../engine/ui/menuArt';
import { TRACKS } from '../career/career';
import { NetPeer, type CloseReason, type NetMessage } from '../net/peer';
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

/** Домовленість у сесії; живе, поки живе з'єднання (повернення із заїзду — до неї ж). */
export interface NetLobby {
  peer: NetPeer;
  level: string;
  rain: boolean;
  truck: number;
  friendTruck: number | null;
  /** Друг зараз на трасі (почав заїзд і ще не повернувся до сесії). */
  friendDriving: boolean;
  /** Друг завантажив трасу поточного заїзду (для господаря — можна давати старт). */
  friendReady: boolean;
}

/** Початок заїзду: траса, погода, вантажівки й місця на старті (господар — 0). */
export interface NetStart {
  lobby: NetLobby;
  level: string;
  rain: boolean;
  truck: number;
  friendTruck: number;
  grid: number;
}

/**
 * Повідомлення сесії, що приходять і поза екраном сесії (на трасі): вибір друга, «друг повернувся», — оновлюють
 * домовленість. Повертає true, якщо повідомлення про сесію.
 */
export function lobbyMessage(lobby: NetLobby, m: NetMessage): boolean {
  if (m.t === 'setup' && !lobby.peer.host) {
    lobby.level = m.level;
    lobby.rain = m.rain;
  } else if (m.t === 'pick') lobby.friendTruck = m.truck;
  else if (m.t === 'lobby') lobby.friendDriving = false;
  else if (m.t === 'start') lobby.friendDriving = true;
  else if (m.t === 'ready') lobby.friendReady = true;
  else return false;
  return true;
}

export function startOf(lobby: NetLobby, level = lobby.level, rain = lobby.rain): NetStart {
  return { lobby, level, rain, truck: lobby.truck, friendTruck: lobby.friendTruck ?? lobby.truck, grid: lobby.peer.host ? 0 : 1 };
}

/**
 * Розділ «Мережева гра»: з'єднання → сесія. Результат — початок заїзду (null — головне меню). from — повернення
 * із заїзду до сесії з тим самим з'єднанням.
 */
export async function netMenu(art: MenuArt, driver: string, trucks: NetTruck[], from: NetLobby | null = null): Promise<NetStart | null> {
  let note: string | null = null;
  let lobby = from;
  for (;;) {
    if (!lobby) {
      const peer = await connectScreen(art, driver, note);
      if (!peer) return null;
      lobby = { peer, level: 'CIRCUIT', rain: false, truck: trucks.some((t) => t.index === 1) ? 1 : (trucks[0]?.index ?? 1), friendTruck: null, friendDriving: false, friendReady: false };
    }
    const r = await sessionScreen(art, driver, lobby, trucks);
    if (typeof r !== 'string' && r) return r;
    note = r;
    lobby = null;
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
 * dev-сервер без HTTPS, ПК; або надіслати месенджером). Результат — з'єднаний друг (null — головне меню).
 */
function connectScreen(art: MenuArt, driver: string, note: string | null): Promise<NetPeer | null> {
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
      const v = friend.value.trim();
      if (v.startsWith('HT1') && v.split(/\s+/).length >= 4) void gotCode(v);
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
      maskButton(scr, art, 'c/client', 327, 326, startJoin, { selected: () => mode === 'join' }),
      maskButton(scr, art, 'c/change', 21, 326, () => ((textMode = camera ? !textMode : true), layout()), { selected: () => textMode }),
    ];
    maskButton(scr, art, 'c/2main', 21, 389, () => done(null));
    scr.keys(null, () => done(null));

    info.innerHTML = `<p>Гра вдвох по Wi-Fi — телефони мають бути в одній мережі.</p>
      <p><b>СТВОРИТИ ГРУ</b> — покажіть QR-код другу й відскануйте його відповідь.</p>
      <p><b>ПРИЄДНАТИСЯ</b> — відскануйте QR-код друга й покажіть йому свій.</p>
      <p><b>КОД ТЕКСТОМ</b> — ті самі коди текстом: надіслати месенджером${camera ? '' : ' (камера тут недоступна — потрібен HTTPS)'}.</p>`;
    if (note) {
      const p = el('p', 'net-note');
      p.textContent = note;
      info.prepend(p);
    }
    layout();
  });
}

/**
 * Сесія (s/back_net): хто в грі, затримка, тип зв'язку; господар обирає трасу й погоду, кожен — свою вантажівку.
 * СТАРТ (господар) — обидва вантажать трасу; ВИЙТИ — закрити з'єднання. Результат — початок заїзду або причина
 * закриття для екрана з'єднання (null — вийшли самі).
 */
function sessionScreen(art: MenuArt, driver: string, lobby: NetLobby, trucks: NetTruck[]): Promise<NetStart | string | null> {
  return new Promise((resolve) => {
    const { peer } = lobby;
    const scr = new Screen(art, 's/back_net.txr');
    const box = scr.place(el('div', 'net-text net-session'), 34, 30, 408, 410);
    const head = el('div', '');
    const levelRow = el('div', 'net-chips');
    const weatherRow = el('div', 'net-chips');
    const truckRow = el('div', 'net-chips net-trucks');
    const foot = el('p', 'net-note');
    const label = (text: string) => {
      const p = el('div', 'net-label');
      p.textContent = text;
      return p;
    };
    box.append(head, label('ТРАСА'), levelRow, label('ПОГОДА'), weatherRow, label('ВАША ВАНТАЖІВКА'), truckRow, foot);
    let route: string | null = null;
    const nameOf = (i: number | null) => (i === null ? '…' : (trucks.find((t) => t.index === i)?.name ?? `№${i}`));
    const chip = (row: HTMLElement, text: string, on: boolean, enabled: boolean, click: () => void) => {
      const b = el('button', `net-chip${on ? ' on' : ''}`);
      b.textContent = text;
      b.disabled = !enabled;
      b.addEventListener('click', click);
      row.append(b);
    };
    const sendSetup = () => peer.send({ t: 'setup', level: lobby.level, rain: lobby.rain });
    const renderHead = () => {
      const me = `${driver}${peer.host ? ' (створив гру)' : ''} — ${nameOf(lobby.truck)}`;
      const him = `${peer.peerName ?? '…'}${peer.host ? '' : ' (створив гру)'} — ${nameOf(lobby.friendTruck)}${lobby.friendDriving ? ' (на трасі)' : ''}`;
      const ms = peer.rtt === null ? '…' : `${Math.round(peer.rtt)} мс`;
      const how = route === 'host' ? 'напряму в мережі' : route === 'srflx' ? 'напряму через інтернет' : '…';
      head.innerHTML = `<h3>МЕРЕЖЕВА ГРА</h3>
        <p class="net-player">1. ${escapeHtml(me)}</p><p class="net-player">2. ${escapeHtml(him)}</p>
        <p>Затримка: ${ms} · ${how}</p>`;
    };
    const render = () => {
      renderHead();
      levelRow.replaceChildren();
      for (const [id, title] of NET_TRACKS)
        chip(levelRow, title, lobby.level === id, peer.host, () => {
          lobby.level = id;
          sendSetup();
          render();
        });
      weatherRow.replaceChildren();
      for (const [rain, title] of [[false, 'Сухо'], [true, 'Дощ']] as const)
        chip(weatherRow, title, lobby.rain === rain, peer.host, () => {
          lobby.rain = rain;
          sendSetup();
          render();
        });
      truckRow.replaceChildren();
      for (const t of trucks)
        chip(truckRow, t.name, lobby.truck === t.index, true, () => {
          lobby.truck = t.index;
          peer.send({ t: 'pick', truck: t.index });
          render();
        });
      foot.textContent = peer.host ? 'Оберіть трасу й натисніть СТАРТ — друг завантажить її разом з вами.' : 'Трасу й погоду обирає той, хто створив гру. Чекаємо, поки він натисне СТАРТ.';
    };
    // Раз на секунду — лише рядки гравців (кнопки вибору не перебудовуємо — не збивати натискання).
    const timer = window.setInterval(() => {
      renderHead();
      void peer.route().then((r) => (route = r));
    }, 1000);
    const done = (v: NetStart | string | null) => {
      clearInterval(timer);
      scr.close();
      resolve(v);
    };
    peer.events = {
      onMessage: (m) => {
        if (m.t === 'start') {
          lobby.friendDriving = true;
          return done(startOf(lobby, m.level, m.rain));
        }
        if (lobbyMessage(lobby, m)) render();
      },
      onClose: (reason) => done(CLOSE_TEXT[reason] || null),
    };
    const leave = () => {
      peer.close();
      done(null);
    };
    if (peer.host) {
      maskButton(scr, art, 's/start', 489, 17, () => {
        lobby.friendReady = false;
        peer.send({ t: 'start', level: lobby.level, rain: lobby.rain });
        lobby.friendDriving = true;
        done(startOf(lobby));
      });
      maskButton(scr, art, 's/cancel', 489, 77, leave);
    } else maskButton(scr, art, 's/cancel', 489, 17, leave);
    scr.keys(null, leave);
    // Друзі мають знати вибір одне одного (і після повернення із заїзду).
    peer.send({ t: 'pick', truck: lobby.truck });
    if (peer.host) sendSetup();
    peer.send({ t: 'lobby' });
    render();
    void peer.route().then((r) => (route = r));
  });
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

/**
 * «Мережева гра» — екрани мережевої гри оригіналу з LOAD.RES: «Способи з'єднання» (c/back_con) і сесія
 * (s/back_net). Сама мережа — власна (net/): гра вдвох через Wi-Fi, коди з'єднання — QR чи текстом.
 * Рамки кнопок (зіставлення масок із фоном, як для інших екранів): c/change (21,326), c/client (327,326),
 * c/2main (21,389), c/server (327,389); s/cancel і s/start — одна рамка (489,17). Панелі: c — x 21…439,
 * y 113…311 (заголовок праворуч угорі, y 120…128); s — x 19…456, y 17…454.
 */
import type { MenuArt } from '../engine/ui/menuArt';
import { NetPeer, type CloseReason } from '../net/peer';
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

/** Розділ «Мережева гра»: з'єднання → сесія → знову з'єднання; повертається до головного меню. */
export async function netMenu(art: MenuArt, driver: string): Promise<void> {
  let note: string | null = null;
  for (;;) {
    const peer = await connectScreen(art, driver, note);
    if (!peer) return;
    note = await sessionScreen(art, driver, peer);
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

/** Сесія (s/back_net): хто в грі, затримка, тип зв'язку; ВИЙТИ — закрити з'єднання. Результат — причина для екрана з'єднання. */
function sessionScreen(art: MenuArt, driver: string, peer: NetPeer): Promise<string | null> {
  return new Promise((resolve) => {
    const scr = new Screen(art, 's/back_net.txr');
    const box = scr.place(el('div', 'net-text net-session'), 34, 30, 408, 410);
    let route: string | null = null;
    const render = () => {
      const me = `${driver}${peer.host ? ' (створив гру)' : ''}`;
      const him = `${peer.peerName ?? '…'}${peer.host ? '' : ' (створив гру)'}`;
      const ms = peer.rtt === null ? '…' : `${Math.round(peer.rtt)} мс`;
      const how = route === 'host' ? 'напряму в локальній мережі' : route === 'srflx' ? 'напряму через інтернет' : route ? route : '…';
      box.innerHTML = `<h3>МЕРЕЖЕВА ГРА</h3>
        <p>Гравці:</p><p class="net-player">1. ${escapeHtml(me)}</p><p class="net-player">2. ${escapeHtml(him)}</p>
        <p>Затримка: ${ms}</p><p>Зв’язок: ${how}</p>
        <p class="net-note">З’єднання працює. Спільна гонка — наступним кроком.</p>`;
    };
    const timer = window.setInterval(() => {
      render();
      void peer.route().then((r) => (route = r));
    }, 1000);
    const done = (v: string | null) => {
      clearInterval(timer);
      scr.close();
      resolve(v);
    };
    peer.events = { onClose: (reason) => done(CLOSE_TEXT[reason] || null) };
    maskButton(scr, art, 's/cancel', 489, 17, () => {
      peer.close();
      done(null);
    });
    scr.keys(null, () => {
      peer.close();
      done(null);
    });
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

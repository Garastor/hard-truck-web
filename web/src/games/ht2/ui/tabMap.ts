import * as THREE from 'three';
import type { EscArt } from './escArt';
import type { RoadLine } from '../world/roads';
import type { MapPoint } from '../world/worldMap';
import { roadPath, type MapReveal } from '../world/mapReveal';
import { hudScale } from '../engine/ui/pixelFont';

/**
 * Карта king.exe (0x529890, re/notes/ht2/ui.md §5) — і огляд світу, і мінікарта; малюється поверх їзди (гра не
 * зупиняється). Tab (кнопка «Карта») перемикає стани по колу: сховано → огляд → мінікарта → сховано.
 * - Огляд: світ вписано в екран — масштаб min((W − 80) / ширина світу, (H − 130) / висота), відступ 40 зліва й
 *   згори.
 * - Мінікарта: масштаб удвічі більший, гравець — у точці (W/6, H/2), карта обрізана прямокутником
 *   x ∈ [W/20, W/3 − W/20], y ∈ [H/4, 3H/4] із синьою рамкою (0, 120, 255).
 * Дороги — лінії кольору (0, 255, 120). Значки `m_16\I_*.msk` — лівим верхнім кутом у (x − 5, y − 5), як в
 * оригіналі: склад-місто `I_city0` з назвою (MENU.FON, базова лінія y − 5 від x − 20), заправка `I_fuel0`, стоянки
 * `I_park` (вузли WAY `mapPark*`, king.exe 0x52a27d; не ринки — стоянок 17, ринків 15), СТО `I_repair` — лише на мінікарті; ціль блимає `I_city0…3…1` (`I_fuel…`) — кадр змінюється кожні
 * 0,125 с; гравець — `I_tr_myNN_K`: NN — напрям (24 сектори по 15° за годинниковою стрілкою від півночі карти),
 * K — кадр анімації 0…5 (той самий лічильник); далекобійники й суперники гонки — `I_tr_opp`; фініш гонки —
 * `I_race` з написом; причепи з вантажем — `I_trailer` (і на мінікарті, і на карті, 0x529890); діючі завали —
 * `I_debris`.
 * Відхилення порту на малих екранах: рамка мінікарти не заходить на кнопки (верхній ряд і сенсорні), масштаб
 * мінікарти не дрібніший, ніж у king.exe при 1024×768; гравець — у центрі рамки; рамка на 15% менша.
 * Гіпотези: колір підписів (палітра екрана, індекс 5, не розібрано); оригінал показує суперників лише з певним
 * прапорцем гравця (0x80, імовірно покращення) чи в мережевій грі — у порту завжди. Дороги з прапорцем 0x20 сховано,
 * доки гравець їх не проїде (world/mapReveal.ts, king.exe 0x42cf50 → 0x529850).
 */
export type TabMapState = 0 | 1 | 2;

const ROAD = 'rgb(0, 255, 120)';
const FRAME = 'rgb(0, 120, 255)';
const LABEL = 'rgb(240, 232, 150)';
/** Поля огляду, CSS px (king.exe: ширина − 80, висота − 130, відступ 40). */
const MARGIN_X = 80;
const MARGIN_Y = 130;
const OFFSET = 40;
/** Запас огляду від безпечної зони (вирізу телефона), CSS px: підписи міст починаються на 20 px лівіше значка. */
const SAFE_GAP = 24;
/** Кадр анімації значків, с (king.exe: 0,125 с; 6 кадрів). */
const FRAME_TIME = 0.125;
/** Екран, масштаб якого — найдрібніший для мінікарти порту (CSS px). */
const REF_W = 1024;
const REF_H = 768;
/** Проміжок між мінікартою й кнопками (з рамкою групи), CSS px. */
const AVOID_GAP = 10;
/** Мінікарта порту трохи менша за прямокутник king.exe (на прохання користувача): ширина й висота × 0,85. */
const MINI_SHRINK = 0.85;
/** Запас canvas мінікарти навколо рамки для значків і підписів (CSS px при масштабі 1); праворуч — довгі назви. */
const PAD = 24;
const PAD_RIGHT = 140;

export interface TabMapScene {
  me: THREE.Vector3;
  /** Напрям руху гравця (Three.js). */
  heading: THREE.Vector3;
  rivals: readonly THREE.Vector3[];
  /**
   * Мережева гра: машини інших гравців — значок суперника з кільцем кольору гравця (як список праворуч і маркер над
   * машиною; власний елемент порту, у king.exe гравці мережі — звичайні значки суперників).
   */
  players?: readonly { pos: THREE.Vector3; color: string }[];
  /** Свої наймані водії (career/hired.ts) — `I_tr_myc`, без імені. */
  mine?: readonly THREE.Vector3[];
  /** Причепи з вантажем (дорожні місії, vehicles/presents.ts) — `I_trailer`, без блимання. */
  trailers?: readonly THREE.Vector3[];
  /** Діючі завали (world/obstacles.ts) — `I_debris`, перед значком гравця (0x4420b0 → 0x529890). */
  debris?: readonly THREE.Vector3[];
  /** Ціль (склад чи заправка) — її значок блимає. */
  target: THREE.Vector3 | null;
  /** Фініш гонки. */
  finish?: THREE.Vector3 | null;
  finishLabel?: string;
}

export class TabMap {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private roads = new Path2D();
  /** Версія `reveal`, з якою зібрано `roads`. */
  private roadsVersion = -1;
  private readonly bounds = new THREE.Box2();
  state: TabMapState = 0;
  private time = 0;
  /** Межі кнопок порту, з-під яких зсувається мінікарта. */
  private avoid: DOMRect[] = [];
  private avoidAt = -1;
  /** Висота табло (CSS px) і коли її перечитано. */
  private top = 0;
  private topAt = -1;
  /** Безпечна зона екрана зліва й справа (виріз телефона), CSS px. */
  private safeL = 0;
  private safeR = 0;
  /** Підпис останнього намальованого кадру й розміщення canvas (CSS). */
  private sig = '';
  private css = '';
  private cache: { canvas: HTMLCanvasElement; k: number; dpr: number; w: number; h: number; x0: number; y0: number } | null = null;
  private readonly v2 = new THREE.Vector2();

  constructor(
    private readonly art: EscArt,
    parent: HTMLElement,
    private readonly lines: readonly RoadLine[],
    private readonly points: readonly MapPoint[],
    private readonly reveal: MapReveal | null = null,
  ) {
    for (const l of lines) for (const p of l.pts) this.bounds.expandByPoint(new THREE.Vector2(p.x, p.z));
    this.canvas.className = 'ht2-tabmap';
    this.canvas.hidden = true;
    this.ctx = this.canvas.getContext('2d')!;
    parent.append(this.canvas);
  }

  /**
   * Відступ мінікарти від кнопок порту: верхній край — нижче кнопок, що над прямокутником, нижній — вище сенсорних
   * кнопок під ним (оригінальна розмітка W/20…W/3 − W/20 × H/4…3H/4 на телефоні накриває керування); групи кнопок —
   * разом із металевою рамкою. Межі перечитуються раз на пів секунди; якщо місця лишається менше 80 px — прямокутник
   * оригіналу. Далі прямокутник зменшується до MINI_SHRINK від лівого верхнього кута.
   */
  private fitBox(box: { x0: number; x1: number; y0: number; y1: number }, H: number): void {
    if (this.time - this.avoidAt > 0.5 || this.avoidAt > this.time) {
      this.avoidAt = this.time;
      this.avoid = [...document.querySelectorAll<HTMLElement>('.touch-btn, .ht2-hud, .ht2-hud button, .touch-top-row, .touch-more')]
        // Видимі (не display: none); offsetParent не годиться — у position: fixed (.ht2-hud) він завжди null.
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => e.getBoundingClientRect());
    }
    let y0 = box.y0;
    let y1 = box.y1;
    for (const r of this.avoid) {
      if (r.right < box.x0 || r.left > box.x1 || r.bottom < box.y0 || r.top > box.y1) continue;
      if ((r.top + r.bottom) / 2 < H / 2) y0 = Math.max(y0, Math.ceil(r.bottom) + AVOID_GAP);
      else y1 = Math.min(y1, Math.floor(r.top) - AVOID_GAP);
    }
    if (y1 - y0 >= 80) Object.assign(box, { y0, y1 });
    box.x1 = box.x0 + Math.round((box.x1 - box.x0) * MINI_SHRINK);
    box.y1 = box.y0 + Math.round((box.y1 - box.y0) * MINI_SHRINK);
  }

  /** Наступний стан: сховано → огляд → мінікарта → сховано. */
  cycle(): TabMapState {
    return this.show(((this.state + 1) % 3) as TabMapState);
  }

  show(state: TabMapState): TabMapState {
    this.state = state;
    this.canvas.hidden = state === 0;
    this.sig = '';
    return state;
  }

  hide(): void {
    this.show(0);
  }

  /**
   * Кадр карти. Оптимізація порту (телефон): canvas — лише розміром показаної області (мінікарта — її прямокутник,
   * не весь екран); дороги — з кешу (roadCache), не обведення всього Path2D щокадру; кадр перемальовується лише
   * тоді, коли змінилося щось видиме (зсув карти на піксель пристрою, кадр анімації, значки).
   */
  draw(dt: number, s: TabMapScene): void {
    this.time += dt;
    if (this.state === 0) return;
    const zoom = this.state === 2;
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    // Висота табло (CSS-змінна) — раз на пів секунди: getComputedStyle щокадру перераховує стилі.
    if (this.time - this.topAt > 0.5 || this.topAt > this.time) {
      this.topAt = this.time;
      this.top = parseFloat(getComputedStyle(document.body).getPropertyValue('--ht2-tablo-h')) || 0;
      const cs = getComputedStyle(this.canvas);
      this.safeL = parseFloat(cs.scrollMarginLeft) || 0;
      this.safeR = parseFloat(cs.scrollMarginRight) || 0;
    }
    // Огляд — під табло порту (у king.exe табло 50 px перекриває відступ 40) і, як мінікарта, поза вирізом екрана
    // телефона: бічні відступи — не менше безпечної зони + SAFE_GAP (відхилення порту).
    const top = this.top;
    const left = Math.max(OFFSET, this.safeL + SAFE_GAP);
    const right = Math.max(MARGIN_X - OFFSET, this.safeR + SAFE_GAP);
    const size = this.bounds.getSize(this.v2);
    let k = Math.min((W - left - right) / size.x, (H - top - MARGIN_Y) / size.y);
    let ox = left - this.bounds.min.x * k;
    let oy = top + OFFSET - this.bounds.min.y * k;
    // Прямокутник мінікарти; порт зсуває його краї з-під кнопок (сенсорних і верхнього ряду).
    const box = { x0: Math.floor(W / 20), x1: Math.floor(W / 3 - W / 20), y0: Math.floor(H / 4), y1: Math.floor(H - H / 4) };
    if (zoom) {
      this.fitBox(box, H);
      // На малих екранах — не дрібніше, ніж king.exe при 1024×768 (інакше значки злипаються; відхилення порту).
      const ref = Math.min((REF_W - MARGIN_X) / size.x, (REF_H - MARGIN_Y) / size.y);
      k = 2 * Math.max(k, ref);
      ox = (box.x0 + box.x1) / 2 - s.me.x * k;
      oy = (box.y0 + box.y1) / 2 - s.me.z * k;
    }
    // Область canvas на екрані (CSS px): мінікарта — прямокутник із рамкою і запасом для значків і підписів біля
    // краю (вони виходять за рамку, як в оригіналі), огляд — увесь екран.
    const u = hudScale();
    const pad = Math.ceil(PAD * u);
    const rx = zoom ? Math.max(0, box.x0 - pad) : 0;
    const ry = zoom ? Math.max(0, box.y0 - pad) : 0;
    const rw = zoom ? Math.min(W, box.x1 + 1 + Math.ceil(PAD_RIGHT * u)) - rx : W;
    const rh = zoom ? Math.min(H, box.y1 + 1 + pad) - ry : H;
    const at = (p: THREE.Vector3) => [ox + p.x * k, oy + p.z * k] as const;
    const inside = (x: number, y: number) => !zoom || (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1);
    const phase = Math.floor(this.time / FRAME_TIME) % 6;
    const len = Math.hypot(s.heading.x, s.heading.z) || 1;
    // Напрям: сектор 15° від півночі карти (−z) за годинниковою стрілкою, з відкиданням дробу, як у king.exe.
    let sector = Math.floor((Math.acos(Math.max(-1, Math.min(1, -s.heading.z / len))) * 12) / Math.PI);
    if (s.heading.x < 0) sector = 24 - sector;

    // Підпис кадру: усе, від чого залежить картинка; без змін — canvas не чіпаємо.
    const sig = [rx, ry, rw, rh, dpr, Math.round(ox * dpr), Math.round(oy * dpr), Math.round(k * 1e4), phase, sector];
    const pos = (p: THREE.Vector3) => sig.push(Math.round(p.x * k * dpr), Math.round(p.z * k * dpr));
    if (s.target) pos(s.target);
    if (s.finish) pos(s.finish);
    for (const list of [s.trailers, s.mine, s.rivals, s.debris, s.players?.map((p) => p.pos)]) {
      sig.push(list?.length ?? 0);
      list?.forEach(pos);
    }
    const key = sig.join(',');
    if (key === this.sig) return;
    this.sig = key;

    const cw = Math.round(rw * dpr);
    const ch = Math.round(rh * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const css = `${rx},${ry},${rw},${rh}`;
    if (css !== this.css) {
      this.css = css;
      Object.assign(this.canvas.style, { left: `${rx}px`, top: `${ry}px`, width: `${rw}px`, height: `${rh}px`, right: 'auto', bottom: 'auto' });
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = false;
    // Дороги: кеш навколо видимої області, на ціле зміщення пікселя пристрою (без перемасштабування).
    const cache = this.roadCache(k, ox, oy, rx, ry, rw, rh, dpr, zoom ? 3 : 1);
    ctx.save();
    if (zoom) {
      ctx.beginPath();
      ctx.rect((box.x0 + 1 - rx) * dpr, (box.y0 + 1 - ry) * dpr, (box.x1 - box.x0 - 1) * dpr, (box.y1 - box.y0 - 1) * dpr);
      ctx.clip();
    }
    ctx.drawImage(cache.canvas, Math.round((ox + cache.x0 * k - rx) * dpr), Math.round((oy + cache.y0 * k - ry) * dpr));
    ctx.restore();
    // Далі — у CSS px екрана.
    ctx.setTransform(dpr, 0, 0, dpr, -rx * dpr, -ry * dpr);
    if (zoom) {
      ctx.strokeStyle = FRAME;
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x0 + 0.5, box.y0 + 0.5, box.x1 - box.x0, box.y1 - box.y0);
    }

    // Значки: масштаб інтерфейсу (на телефоні 1:1), лівий верхній кут — (x − 5, y − 5).
    const icon = (name: string, p: THREE.Vector3) => {
      const [x, y] = at(p);
      if (!inside(x, y)) return;
      const img = this.art.canvas(`m_16\\${name}.msk`);
      if (img) ctx.drawImage(img, Math.round(x - 5 * u), Math.round(y - 5 * u), img.width * u, img.height * u);
    };
    const label = (text: string, p: THREE.Vector3) => {
      const font = this.art.menu;
      const [x, y] = at(p);
      if (!font || !inside(x, y)) return;
      ctx.save();
      ctx.translate(Math.round(x - 20 * u), Math.round(y - 5 * u));
      ctx.scale(u, u);
      font.draw(ctx, text, 0, -font.height, LABEL);
      ctx.restore();
    };
    const blink = phase <= 3 ? phase : 6 - phase;
    const isTarget = (p: THREE.Vector3) => !!s.target && p.distanceTo(s.target) < 30;
    for (const pt of this.points) {
      if (pt.kind === 'town') icon(`I_city${isTarget(pt.pos) ? blink : 0}`, pt.pos);
      else if (pt.kind === 'fuel') icon(`I_fuel${isTarget(pt.pos) ? blink : 0}`, pt.pos);
      else if (pt.kind === 'park') icon('I_park', pt.pos);
      else if (pt.kind === 'market') continue;
      else if (zoom) icon('I_repair', pt.pos);
    }
    for (const pt of this.points) if (pt.kind === 'town' && pt.label) label(pt.label.toUpperCase(), pt.pos);
    if (s.finish) {
      icon('I_race', s.finish);
      if (s.finishLabel) label(s.finishLabel, s.finish);
    }
    for (const t of s.trailers ?? []) icon('I_trailer', t);
    for (const m of s.mine ?? []) icon('I_tr_myc', m);
    for (const r of s.rivals) icon('I_tr_opp', r);
    for (const pl of s.players ?? []) {
      const [x, y] = at(pl.pos);
      if (!inside(x, y)) continue;
      ctx.beginPath();
      ctx.arc(x, y, 7 * u, 0, Math.PI * 2);
      ctx.lineWidth = 2.5 * u;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.stroke();
      ctx.lineWidth = 1.5 * u;
      ctx.strokeStyle = pl.color;
      ctx.stroke();
      icon('I_tr_opp', pl.pos);
    }
    for (const d of s.debris ?? []) icon('I_debris', d);
    icon(`I_tr_my${String(sector % 24).padStart(2, '0')}_${phase}`, s.me);
  }

  /**
   * Кеш доріг: canvas у пікселях пристрою з масштабом k, що покриває видиму область (rx, ry, rw × rh CSS px) із
   * запасом `margin` (мінікарта — утричі більша за прямокутник: перебудова, лише коли гравець виїде з середини).
   * x0, y0 — світові координати (x, z) лівого верхнього кута.
   */
  private roadCache(k: number, ox: number, oy: number, rx: number, ry: number, rw: number, rh: number, dpr: number, margin: number): { canvas: HTMLCanvasElement; x0: number; y0: number } {
    // Видима область у світі.
    const vx0 = (rx - ox) / k;
    const vy0 = (ry - oy) / k;
    const vx1 = (rx + rw - ox) / k;
    const vy1 = (ry + rh - oy) / k;
    // Відкрилась нова ділянка — дороги й кеш наново.
    const version = this.reveal?.version ?? 0;
    if (version !== this.roadsVersion) {
      this.roadsVersion = version;
      this.roads = roadPath(this.lines, this.reveal);
      this.cache = null;
    }
    const c = this.cache;
    const fits = c && c.k === k && c.dpr === dpr && c.w >= rw * margin && c.h >= rh * margin && vx0 >= c.x0 && vy0 >= c.y0 && vx1 <= c.x0 + c.w / k && vy1 <= c.y0 + c.h / k;
    if (fits) return c;
    const w = Math.ceil(rw * margin);
    const h = Math.ceil(rh * margin);
    const canvas = c?.canvas ?? document.createElement('canvas');
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    // Центр кешу — центр видимої області.
    const x0 = (vx0 + vx1) / 2 - w / k / 2;
    const y0 = (vy0 + vy1) / 2 - h / k / 2;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, -x0 * k * dpr, -y0 * k * dpr);
    ctx.clearRect(x0, y0, w / k, h / k);
    ctx.strokeStyle = ROAD;
    ctx.lineWidth = 1 / k;
    ctx.stroke(this.roads);
    this.cache = { canvas, k, dpr, w, h, x0, y0 };
    return this.cache;
  }

  dispose(): void {
    this.canvas.remove();
  }
}


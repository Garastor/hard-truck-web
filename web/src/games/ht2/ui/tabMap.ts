import * as THREE from 'three';
import type { EscArt } from './escArt';
import type { RoadLine } from '../world/roads';
import type { MapPoint } from '../world/worldMap';
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
 * `I_park`, СТО `I_repair` — лише на мінікарті; ціль блимає `I_city0…3…1` (`I_fuel…`) — кадр змінюється кожні
 * 0,125 с; гравець — `I_tr_myNN_K`: NN — напрям (24 сектори по 15° за годинниковою стрілкою від півночі карти),
 * K — кадр анімації 0…5 (той самий лічильник); далекобійники й суперники гонки — `I_tr_opp`; фініш гонки —
 * `I_race` з написом.
 * Відхилення порту на малих екранах: рамка мінікарти не заходить на кнопки (верхній ряд і сенсорні), масштаб
 * мінікарти не дрібніший, ніж у king.exe при 1024×768; гравець — у центрі рамки; рамка на 15% менша.
 * Гіпотези: колір підписів (палітра екрана, індекс 5, не розібрано); оригінал показує суперників лише з певним
 * прапорцем гравця (0x80, імовірно покращення) чи в мережевій грі — у порту завжди; дороги з прапорцем 0x20
 * оригінал ховає, доки їх не «відкриє» подія (0x529850) — у порту видно всі.
 */
export type TabMapState = 0 | 1 | 2;

const ROAD = 'rgb(0, 255, 120)';
const FRAME = 'rgb(0, 120, 255)';
const LABEL = 'rgb(240, 232, 150)';
/** Поля огляду, CSS px (king.exe: ширина − 80, висота − 130, відступ 40). */
const MARGIN_X = 80;
const MARGIN_Y = 130;
const OFFSET = 40;
/** Кадр анімації значків, с (king.exe: 0,125 с; 6 кадрів). */
const FRAME_TIME = 0.125;
/** Екран, масштаб якого — найдрібніший для мінікарти порту (CSS px). */
const REF_W = 1024;
const REF_H = 768;
/** Проміжок між мінікартою й кнопками (з рамкою групи), CSS px. */
const AVOID_GAP = 10;
/** Мінікарта порту трохи менша за прямокутник king.exe (на прохання користувача): ширина й висота × 0,85. */
const MINI_SHRINK = 0.85;

export interface TabMapScene {
  me: THREE.Vector3;
  /** Напрям руху гравця (Three.js). */
  heading: THREE.Vector3;
  rivals: readonly THREE.Vector3[];
  /** Ціль (склад чи заправка) — її значок блимає. */
  target: THREE.Vector3 | null;
  /** Фініш гонки. */
  finish?: THREE.Vector3 | null;
  finishLabel?: string;
}

export class TabMap {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly roads = new Path2D();
  private readonly bounds = new THREE.Box2();
  state: TabMapState = 0;
  private time = 0;
  /** Межі кнопок порту, з-під яких зсувається мінікарта. */
  private avoid: DOMRect[] = [];
  private avoidAt = -1;

  constructor(
    private readonly art: EscArt,
    parent: HTMLElement,
    lines: readonly RoadLine[],
    private readonly points: readonly MapPoint[],
  ) {
    for (const l of lines)
      l.pts.forEach((p, i) => {
        if (i) this.roads.lineTo(p.x, p.z);
        else this.roads.moveTo(p.x, p.z);
        this.bounds.expandByPoint(new THREE.Vector2(p.x, p.z));
      });
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
    return state;
  }

  hide(): void {
    this.show(0);
  }

  draw(dt: number, s: TabMapScene): void {
    this.time += dt;
    if (this.state === 0) return;
    const zoom = this.state === 2;
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    // Огляд — під табло порту (у king.exe табло 50 px перекриває відступ 40).
    const top = parseFloat(getComputedStyle(document.body).getPropertyValue('--ht2-tablo-h')) || 0;
    const size = this.bounds.getSize(new THREE.Vector2());
    let k = Math.min((W - MARGIN_X) / size.x, (H - top - MARGIN_Y) / size.y);
    let ox = OFFSET - this.bounds.min.x * k;
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
    const at = (p: THREE.Vector3) => [ox + p.x * k, oy + p.z * k] as const;
    const inside = (x: number, y: number) => !zoom || (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1);
    if (zoom) {
      ctx.strokeStyle = FRAME;
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x0 + 0.5, box.y0 + 0.5, box.x1 - box.x0, box.y1 - box.y0);
    }
    ctx.save();
    if (zoom) {
      ctx.beginPath();
      ctx.rect(box.x0 + 1, box.y0 + 1, box.x1 - box.x0 - 1, box.y1 - box.y0 - 1);
      ctx.clip();
    }
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    ctx.strokeStyle = ROAD;
    ctx.lineWidth = 1 / k;
    ctx.stroke(this.roads);
    ctx.restore();

    // Значки: масштаб інтерфейсу (на телефоні 1:1), лівий верхній кут — (x − 5, y − 5).
    const u = hudScale();
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
    const phase = Math.floor(this.time / FRAME_TIME) % 6;
    const blink = phase <= 3 ? phase : 6 - phase;
    const isTarget = (p: THREE.Vector3) => !!s.target && p.distanceTo(s.target) < 30;
    for (const pt of this.points) {
      if (pt.kind === 'town') icon(`I_city${isTarget(pt.pos) ? blink : 0}`, pt.pos);
      else if (pt.kind === 'fuel') icon(`I_fuel${isTarget(pt.pos) ? blink : 0}`, pt.pos);
      else if (pt.kind === 'market') icon('I_park', pt.pos);
      else if (zoom) icon('I_repair', pt.pos);
    }
    for (const pt of this.points) if (pt.kind === 'town' && pt.label) label(pt.label.toUpperCase(), pt.pos);
    if (s.finish) {
      icon('I_race', s.finish);
      if (s.finishLabel) label(s.finishLabel, s.finish);
    }
    for (const r of s.rivals) icon('I_tr_opp', r);
    // Напрям: сектор 15° від півночі карти (−z) за годинниковою стрілкою, з відкиданням дробу, як у king.exe.
    const len = Math.hypot(s.heading.x, s.heading.z) || 1;
    let sector = Math.floor((Math.acos(Math.max(-1, Math.min(1, -s.heading.z / len))) * 12) / Math.PI);
    if (s.heading.x < 0) sector = 24 - sector;
    icon(`I_tr_my${String(sector % 24).padStart(2, '0')}_${phase}`, s.me);
  }

  dispose(): void {
    this.canvas.remove();
  }
}

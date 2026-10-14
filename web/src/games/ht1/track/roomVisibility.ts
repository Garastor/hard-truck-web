/**
 * Видимість кімнат через портали (як в оригіналі): малюємо кімнату з камерою і ті, що видно крізь
 * портали (блоки 30), звужуючи прямокутник екрана на кожному порталі. Так геометрія сусідніх кімнат,
 * що перетинається в просторі (тунель траси крізь зал бази), не видна з іншої кімнати, а телефон
 * не малює невидиме.
 */
import * as THREE from 'three';
import { isHorizontalPortal, portalCorners, type Portal, type Track } from './track';

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Камера ближче до площини порталу (м) і в межах його прорізу — кімната за ним видима завжди. Камера з кабіни
 * попереду центру машини: на межі залів вона вже за порталом, а кімната машини — ще попередня; портал тоді
 * позаду камери, і без цього перед нею нічого не малювалось (база, межа room_000 / room_100).
 */
const NEAR_PORTAL = 3;

/** Обмеження обходу: глибина ланцюжка порталів і загальна кількість переходів за кадр. */
const MAX_DEPTH = 24;
const MAX_STEPS = 600;

export class RoomVisibility {
  private readonly groups = new Map<string, THREE.Object3D>();
  private readonly corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  readonly visible = new Set<string>();

  constructor(
    private readonly track: Track,
    rooms: THREE.Object3D[],
  ) {
    for (const r of rooms) this.groups.set(r.name, r);
  }

  /** Показати все (кімната невідома). */
  showAll(): void {
    for (const g of this.groups.values()) g.visible = true;
  }

  update(camera: THREE.PerspectiveCamera, start: string | null): void {
    if (!start || !this.track.rooms.has(start)) return this.showAll();
    camera.updateMatrixWorld();
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.visible.clear();
    this.visible.add(start);
    const queue: [string, Rect, number][] = [[start, { x0: -1, y0: -1, x1: 1, y1: 1 }, 0]];
    let steps = 0;
    while (queue.length && steps < MAX_STEPS) {
      const [room, rect, depth] = queue.shift()!;
      const r = this.track.rooms.get(room);
      if (!r || depth >= MAX_DEPTH) continue;
      for (const p of r.portals) {
        steps++;
        const sub = this.near(p, camera.position) ? { ...rect } : this.portalRect(p, vp, rect);
        if (!sub) continue;
        const seen = this.visible.has(p.to);
        this.visible.add(p.to);
        // Уже видима кімната — далі не йдемо (окрім випадку, коли крізь неї видно більшу частину екрана).
        if (!seen || (sub.x1 - sub.x0) * (sub.y1 - sub.y0) > 0.25) queue.push([p.to, sub, depth + 1]);
      }
    }
    for (const [name, g] of this.groups) g.visible = this.visible.has(name);
  }

  /** Камера біля порталу: ближче за NEAR_PORTAL до його площини і в межах прорізу (з тим самим запасом). */
  private near(p: Portal, c: THREE.Vector3): boolean {
    if (isHorizontalPortal(p)) {
      const n = NEAR_PORTAL;
      return (
        Math.abs(c.y - p.a.y) < n &&
        c.x > Math.min(p.a.x, p.b.x) - n && c.x < Math.max(p.a.x, p.b.x) + n &&
        c.z > Math.min(p.a.z, p.b.z) - n && c.z < Math.max(p.a.z, p.b.z) + n
      );
    }
    const dx = p.b.x - p.a.x;
    const dz = p.b.z - p.a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return false;
    const along = ((c.x - p.a.x) * dx + (c.z - p.a.z) * dz) / len;
    const across = Math.abs((c.x - p.a.x) * dz - (c.z - p.a.z) * dx) / len;
    const y0 = Math.min(p.a.y, p.b.y);
    const y1 = Math.max(p.a.y, p.b.y);
    return across < NEAR_PORTAL && along > -NEAR_PORTAL && along < len + NEAR_PORTAL && c.y > y0 - NEAR_PORTAL && c.y < y1 + NEAR_PORTAL;
  }

  /** Прямокутник порталу на екрані, обрізаний поточним; null — портал не видно. */
  private portalRect(p: Portal, vp: THREE.Matrix4, clip: Rect): Rect | null {
    portalCorners(p, this.corners);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let behind = 0;
    for (const v of this.corners) {
      const w = v.x * vp.elements[3] + v.y * vp.elements[7] + v.z * vp.elements[11] + vp.elements[15];
      if (w <= 0.05) {
        behind++;
        continue;
      }
      v.applyMatrix4(vp);
      x0 = Math.min(x0, v.x);
      x1 = Math.max(x1, v.x);
      y0 = Math.min(y0, v.y);
      y1 = Math.max(y1, v.y);
    }
    if (behind === 4) return null;
    // Частина порталу за камерою (ми в ньому або дуже близько) — обережно: увесь поточний прямокутник.
    if (behind > 0) {
      // Якщо камера далеко від площини порталу, а він увесь позаду — вже відкинуто; тут — перетин.
      return { ...clip };
    }
    const r = { x0: Math.max(x0, clip.x0), y0: Math.max(y0, clip.y0), x1: Math.min(x1, clip.x1), y1: Math.min(y1, clip.y1) };
    return r.x0 < r.x1 && r.y0 < r.y1 ? r : null;
  }
}


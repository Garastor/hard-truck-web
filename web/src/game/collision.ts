import { walk, type B3d, type Block } from '../formats/b3d';

/**
 * Колізійна геометрія локації (система гри: X — праворуч, Y — уперед, Z — угору).
 *
 * Оригінал тримає колізії окремо від видимої геометрії — в обʼєктах верхнього рівня `hit_road_NNN` /
 * `hit_obj_NNN` для кожної кімнати `room_NNN` (світові координати). Це дерево:
 * - вузли **9** (площина `n·p + d`): група 0 — де `n·p + d ≥ 0`, група 1 — решта (перевірено на COUNT);
 *   вузли 10 (сфера) і 11 (циліндр) — теж поділ простору, тут не обрізають;
 * - листки — колайдери: **23** полігони, **20** ламані-огорожі, **12** площина, **16/17** циліндр
 *   (`a` — центр осі, `b` — напрям осі, `f = [пів-довжина, радіус]`; 16 — суцільний, 17 — порожнистий).
 * Аналітичні фігури перетворюємо на полігони й обрізаємо площинами предків — так Rapier отримує trimesh.
 * Корпуси `hit_<вантажівка>` і рухомі `hitAnmObj*` — локальні, тут не враховуються.
 */
export type Poly = number[][];

export interface LevelCollision {
  /** Полігони, по яких їздять колеса (нормаль переважно вгору). */
  floors: Poly[];
  /** Кімната кожного полігона підлоги (`hit_road_NNN` → `room_NNN`). */
  floorRoom: string[];
  /** Стіни й огорожі. */
  walls: Poly[];
  /** Кімната кожної стіни. */
  wallRoom: string[];
  /** Стіна — з огорожі (блок 20). */
  wallFence: boolean[];
  /** Чи описує `hit_*` поверхню для коліс; інакше землю беремо з видимої геометрії. */
  hasFloor: boolean;
  /** Кількість колайдерів за типами блоків (для налагодження). */
  stats: Record<string, number>;
}

/** Нахил, з якого полігон вважається підлогою, а не стіною (|nz|). */
const FLOOR_MIN_NZ = 0.35;
/** Висота огорож з ламаних (блок 20) — гіпотеза; нижче лінії — запас, щоб не проскочити знизу. */
const FENCE_HEIGHT = 3;
const FENCE_DEPTH = 1;

type Plane = [number, number, number, number];

export function levelCollision(b3d: B3d): LevelCollision {
  const floors: Poly[] = [];
  const floorRoom: string[] = [];
  const walls: Poly[] = [];
  const wallRoom: string[] = [];
  const wallFence: boolean[] = [];
  const stats: Record<string, number> = {};
  const roomBoxes = roomBounds(b3d);
  let room = '';
  let isFence = false;
  const add = (p: Poly) => {
    if (Math.abs(normalZ(p)) < FLOOR_MIN_NZ) {
      walls.push(p);
      wallRoom.push(room);
      wallFence.push(isFence);
      return;
    }
    floors.push(p);
    floorRoom.push(room);
  };

  for (const top of b3d.blocks) {
    const m = /^hit_(road|obj)_(.+)$/i.exec(top.name);
    if (!m) continue;
    room = `room_${m[2]}`;
    const box = roomBoxes.get(room.toLowerCase()) ?? null;
    const visit = (b: Block, clip: Plane[]): void => {
      const d = b.data;
      let emitted: Poly[] = [];
      switch (d.t) {
        case 23:
          if (d.shape.kind === 6) emitted = d.shape.polys.filter((p) => p.length >= 3);
          break;
        case 20:
          for (let i = 0; i + 1 < d.points.length; i++) emitted.push(fence(d.points[i], d.points[i + 1], box));
          break;
        case 12:
          // Площина з нормаллю вниз — стеля (вільний простір під нею). Колізії Rapier двосторонні,
          // тож стелю пропускаємо, щоб вантажівка не опинилася на ній (база MENU3D).
          if (d.shape.kind === 5 && box && d.shape.v[2] > -FLOOR_MIN_NZ) emitted = planePatch(d.shape.v as Plane, box);
          break;
        case 16:
        case 17:
          if (d.shape.kind === 3 || d.shape.kind === 4) {
            emitted = cylinder(d.shape.a, d.shape.b, d.shape.f[0], d.shape.f[1], d.t === 16 ? 'upper' : 'lower');
            if (box) {
              const sides = boxPlanes(box);
              emitted = emitted.map((p) => clipAll(p, sides)).filter((p): p is Poly => p !== null);
            }
          }
          break;
        case 9:
          if (d.shape.kind === 5 && b.groups) {
            const [nx, ny, nz, w] = d.shape.v;
            b.groups[0]?.forEach((c) => visit(c, [...clip, [nx, ny, nz, w]]));
            b.groups[1]?.forEach((c) => visit(c, [...clip, [-nx, -ny, -nz, -w]]));
            return;
          }
          break;
      }
      if (emitted.length) {
        stats[d.t] = (stats[d.t] ?? 0) + 1;
        isFence = d.t === 20;
        for (const p of emitted) {
          const c = clipAll(p, clip);
          if (c) add(c);
        }
        isFence = false;
      }
      for (const g of b.groups ?? []) for (const c of g) visit(c, clip);
    };
    visit(top, []);
  }
  return { floors, floorRoom, walls, wallRoom, wallFence, hasFloor: floors.length > walls.length / 4, stats };
}

/** Наскільки близько до лінії огорожі має лежати портал, щоб вирізати в ній прохід, м. */
const PORTAL_ON_FENCE = 0.5;

/**
 * Вирізає в огорожах (блок 20) проходи там, де на їхній лінії лежить портал (блок 30) будь-якої кімнати. Огорожі —
 * межі кімнат на плані, і огорожа однієї кімнати буває довшою за саму кімнату: на COUNT межа room_017 на y = 1925
 * тягнеться до x = 2755 і перекривала бічний проїзд room_018 → room_195 (x 2714…2738) — «невидима стіна», бо
 * колізії сусідньої кімнати активні. Портали — кути (a, b) у системі гри (x, y); висота не враховується.
 */
export function openPortals(col: LevelCollision, portals: { a: [number, number]; b: [number, number] }[]): number {
  let cut = 0;
  const walls: Poly[] = [];
  const rooms: string[] = [];
  const fences: boolean[] = [];
  col.walls.forEach((w, i) => {
    const keep = (p: Poly, fence: boolean) => {
      walls.push(p);
      rooms.push(col.wallRoom[i]);
      fences.push(fence);
    };
    if (!col.wallFence[i] || w.length !== 4) return keep(w, col.wallFence[i]);
    const [a, b] = [w[0], w[1]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return keep(w, true);
    const gaps: [number, number][] = [];
    for (const p of portals) {
      const off = (q: [number, number]) => Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / len;
      if (off(p.a) > PORTAL_ON_FENCE || off(p.b) > PORTAL_ON_FENCE) continue;
      const t = (q: [number, number]) => ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (len * len);
      const t0 = Math.max(0, Math.min(t(p.a), t(p.b)));
      const t1 = Math.min(1, Math.max(t(p.a), t(p.b)));
      if (t1 > t0) gaps.push([t0, t1]);
    }
    if (!gaps.length) return keep(w, true);
    gaps.sort((g, h) => g[0] - h[0]);
    const z0 = w[0][2];
    const z1 = w[2][2];
    const at = (t: number) => [a[0] + dx * t, a[1] + dy * t];
    let from = 0;
    for (const [g0, g1] of [...gaps, [1, 1] as [number, number]]) {
      if (g0 > from + 1e-4) {
        const [p0, p1] = [at(from), at(g0)];
        keep([[p0[0], p0[1], z0], [p1[0], p1[1], z0], [p1[0], p1[1], z1], [p0[0], p0[1], z1]], true);
      }
      from = Math.max(from, g1);
    }
    cut++;
  });
  col.walls = walls;
  col.wallRoom = rooms;
  col.wallFence = fences;
  return cut;
}

/**
 * Вертикальна огорожа вздовж відрізка ламаної. Ламані з нульовою висотою (усі на COUNT) — межі на плані:
 * стіна на всю висоту кімнати (інакше огорожа опинялася під землею і з траси можна було виїхати й провалитися).
 */
function fence(a: number[], b: number[], box: Box | null): Poly {
  if (box && Math.abs(a[2]) < 0.01 && Math.abs(b[2]) < 0.01) {
    const z0 = box.min[2] - FENCE_DEPTH;
    const z1 = box.max[2] + FENCE_HEIGHT;
    return [
      [a[0], a[1], z0],
      [b[0], b[1], z0],
      [b[0], b[1], z1],
      [a[0], a[1], z1],
    ];
  }
  return [
    [a[0], a[1], a[2] - FENCE_DEPTH],
    [b[0], b[1], b[2] - FENCE_DEPTH],
    [b[0], b[1], b[2] + FENCE_HEIGHT],
    [a[0], a[1], a[2] + FENCE_HEIGHT],
  ];
}

type Box = { min: number[]; max: number[] };

/** Межі кімнат за їхньою видимою геометрією (для обмеження нескінченних площин 12). */
function roomBounds(b3d: B3d): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const room of b3d.blocks) {
    if (room.data.t !== 19) continue;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const [blk] of walk([room])) {
      const d = blk.data;
      if (d.t !== 7 && d.t !== 37 && d.t !== 6 && d.t !== 36) continue;
      if ((d.t === 6 || d.t === 36) && d.name1) continue; // вершини в локальному просторі
      const p = d.positions;
      for (let i = 0; i + 2 < p.length; i += 3)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[i + k]);
          max[k] = Math.max(max[k], p[i + k]);
        }
    }
    if (min[0] > max[0]) continue;
    const pad = 2;
    out.set(room.name.toLowerCase(), { min: min.map((v) => v - pad), max: max.map((v) => v + pad) });
  }
  return out;
}

/** Нескінченна площина `n·p + d = 0`, обрізана коробкою кімнати. */
function planePatch([nx, ny, nz, d]: Plane, box: Box): Poly[] {
  const len = Math.hypot(nx, ny, nz);
  if (!len) return [];
  const n = [nx / len, ny / len, nz / len];
  const dd = d / len;
  const c = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2);
  const dist = n[0] * c[0] + n[1] * c[1] + n[2] * c[2] + dd;
  const o = [c[0] - n[0] * dist, c[1] - n[1] * dist, c[2] - n[2] * dist];
  const u = Math.abs(n[2]) < 0.9 ? normalize(cross(n, [0, 0, 1])) : normalize(cross(n, [1, 0, 0]));
  const v = cross(n, u);
  const r = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  const quad: Poly = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([s, t]) => [0, 1, 2].map((k) => o[k] + (u[k] * s + v[k] * t) * r));
  const poly = clipAll(quad, boxPlanes(box));
  return poly ? [poly] : [];
}

function boxPlanes(box: Box): Plane[] {
  const sides: Plane[] = [];
  for (let k = 0; k < 3; k++) {
    const e = [0, 0, 0];
    e[k] = 1;
    sides.push([e[0], e[1], e[2], -box.min[k]], [-e[0], -e[1], -e[2], box.max[k]]);
  }
  return sides;
}

/**
 * Бічна поверхня циліндра (центр осі a, напрям b, пів-довжина h, радіус r) — смуги вздовж осі.
 * Для горизонтальних лишаємо половину, по якій їздять: у суцільного (16) — верх (горб),
 * у порожнистого (17) — низ (западина).
 */
function cylinder(a: number[], bRaw: number[], h: number, r: number, half: 'upper' | 'lower'): Poly[] {
  const b = normalize(bRaw);
  const vertical = Math.abs(b[2]) > 0.9;
  const u = vertical ? normalize(cross(b, [1, 0, 0])) : normalize(cross(b, [0, 0, 1]));
  let v = cross(b, u);
  if (!vertical && v[2] < 0) v = v.map((x) => -x); // φ ∈ [0, π] — верхня половина
  const [from, span] = vertical ? [0, 2 * Math.PI] : half === 'upper' ? [0, Math.PI] : [Math.PI, Math.PI];
  // Хорда з прогином ≤ 2 см (для R = 293 м — ≈ 7 м, для R = 10 м — ≈ 1,3 м); уздовж осі поверхня пряма —
  // одна смуга (обрізання площинами працює з плоскими смугами точно).
  const chord = Math.min(8, Math.max(0.5, Math.sqrt(8 * r * 0.02)));
  const around = Math.min(512, Math.max(8, Math.ceil((span * r) / chord)));
  const along = 1;
  const at = (i: number, j: number) => {
    const phi = from + (span * i) / around;
    const t = -h + (2 * h * j) / along;
    const cu = Math.cos(phi) * r;
    const cv = Math.sin(phi) * r;
    return [0, 1, 2].map((k) => a[k] + b[k] * t + u[k] * cu + v[k] * cv);
  };
  const out: Poly[] = [];
  for (let i = 0; i < around; i++)
    for (let j = 0; j < along; j++) out.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  return out;
}

/** Відсікання полігона півпросторами `n·p + d ≥ 0` (Сазерленд — Ходжмен). */
function clipAll(poly: Poly, planes: Plane[]): Poly | null {
  let cur = poly;
  for (const [nx, ny, nz, d] of planes) {
    const next: Poly = [];
    for (let i = 0; i < cur.length; i++) {
      const p = cur[i];
      const q = cur[(i + 1) % cur.length];
      const dp = nx * p[0] + ny * p[1] + nz * p[2] + d;
      const dq = nx * q[0] + ny * q[1] + nz * q[2] + d;
      const eps = 1e-3;
      if (dp >= -eps) next.push(p);
      if (dp >= -eps !== dq >= -eps) {
        const t = dp / (dp - dq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
      }
    }
    if (next.length < 3) return null;
    cur = next;
  }
  return cur;
}

function normalZ(p: Poly): number {
  // Нормаль Ньюелла — стійка для неплоских і вироджених полігонів.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const len = Math.hypot(nx, ny, nz);
  return len ? nz / len : 0;
}

function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(a: number[]): number[] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Для тестів і налагодження: чи є підлога під (x, y) на висоті z ± dz. */
export function floorCovers(floors: Poly[], x: number, y: number, z: number, dz = 1.5): boolean {
  for (const p of floors)
    for (let k = 1; k + 1 < p.length; k++) {
      const a = p[0];
      const b = p[k];
      const c = p[k + 1];
      const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(det) < 1e-9) continue;
      const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
      const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
      const w = 1 - u - v;
      if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;
      if (Math.abs(u * a[2] + v * b[2] + w * c[2] - z) <= dz) return true;
    }
  return false;
}

/**
 * Кімната під точкою (система гри): найвища підлога, що накриває (x, y) і лежить не вище z + 1.
 * Потрібна там, де немає точок рестарту (база MENU3D), і як страховка, якщо перетин порталу пропущено.
 */
export function roomAt(col: Pick<LevelCollision, 'floors' | 'floorRoom'>, x: number, y: number, z: number): string | null {
  return floorAt(col, x, y, z)?.room ?? null;
}

/** Найвища підлога під (x, y) не вище z + 1: кімната й висота (система гри). */
export function floorAt(
  col: Pick<LevelCollision, 'floors' | 'floorRoom'>,
  x: number,
  y: number,
  z: number,
  only?: (room: string) => boolean,
): { room: string; z: number } | null {
  let best: string | null = null;
  let bestZ = -Infinity;
  let bestArea = Infinity;
  col.floors.forEach((p, i) => {
    if (only && !only(col.floorRoom[i])) return;
    // Площа охоплюючого прямокутника: на однаковій висоті кращий менший полігон (велика площина
    // головної зали накриває й сусідні кімнати).
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const q of p) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
    const area = (x1 - x0) * (y1 - y0);
    for (let k = 1; k + 1 < p.length; k++) {
      const a = p[0];
      const b = p[k];
      const c = p[k + 1];
      const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(det) < 1e-9) continue;
      const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
      const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
      const w = 1 - u - v;
      if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;
      const fz = u * a[2] + v * b[2] + w * c[2];
      if (fz > z + 1) continue;
      if (fz > bestZ + 0.05 || (fz > bestZ - 0.05 && area < bestArea)) {
        bestZ = Math.max(fz, bestZ);
        bestArea = area;
        best = col.floorRoom[i];
      }
    }
  });
  return best === null ? null : { room: best, z: bestZ };
}

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
 * Вузли **21** (перемикач `refer_<Ключ>`: обвали `Fall…Key`, ремонт мосту `CLOSE_BD_*`…) — колізії гілки діють лише
 * в її стані: полігони позначаємо ключем і гілкою (`<Ключ>#<гілка>`), гра вмикає колайдери гілки сама.
 * Корпуси `hit_<вантажівка>` і рухомі `hitAnmObj*` — локальні, тут не враховуються.
 */
export type Poly = number[][];

export interface LevelCollision {
  /** Полігони, по яких їздять колеса (нормаль переважно вгору). */
  floors: Poly[];
  /** Кімната кожного полігона підлоги (`hit_road_NNN` → `room_NNN`). */
  floorRoom: string[];
  /**
   * Покриття кожного полігона підлоги 1…13 (друге число заголовка колайдера, `i2`; king.exe 0x503e30 → 0x502780 бере
   * його з запису контакту колеса): μ шин, опір кочення, нерівність. 0 — невідоме.
   */
  floorSurface: number[];
  /** Гілка перемикача кожного полігона підлоги (`<Ключ>#<гілка>`, без `refer_`); '' — діє завжди. */
  floorSwitch: string[];
  /** Стіни й огорожі. */
  walls: Poly[];
  /** Кімната кожної стіни. */
  wallRoom: string[];
  /** Стіна — з огорожі (блок 20). */
  wallFence: boolean[];
  /** Гілка перемикача кожної стіни ('' — діє завжди). */
  wallSwitch: string[];
  /** Чи описує `hit_*` поверхню для коліс; інакше землю беремо з видимої геометрії. */
  hasFloor: boolean;
  /** Кількість колайдерів за типами блоків (для налагодження). */
  stats: Record<string, number>;
}

/** Нахил, з якого полігон вважається підлогою, а не стіною (|nz|). */
const FLOOR_MIN_NZ = 0.35;
/** Запас огорож (блок 20) над і під межами кімнати (без кімнати — над і під точками ламаної), м. */
const FENCE_HEIGHT = 3;
const FENCE_DEPTH = 1;

type Plane = [number, number, number, number];

export function levelCollision(b3d: B3d): LevelCollision {
  const floors: Poly[] = [];
  const floorRoom: string[] = [];
  const floorSurface: number[] = [];
  const walls: Poly[] = [];
  const wallRoom: string[] = [];
  const wallFence: boolean[] = [];
  const floorSwitch: string[] = [];
  const wallSwitch: string[] = [];
  const stats: Record<string, number> = {};
  const roomBoxes = roomBounds(b3d);
  const owners = hitOwners(b3d);
  let room = '';
  let isFence = false;
  let surface = 0;
  let sw = '';
  const add = (p: Poly) => {
    if (Math.abs(normalZ(p)) < FLOOR_MIN_NZ) {
      walls.push(p);
      wallRoom.push(room);
      wallFence.push(isFence);
      wallSwitch.push(sw);
      return;
    }
    floors.push(p);
    floorRoom.push(room);
    floorSurface.push(surface);
    floorSwitch.push(sw);
  };

  for (const top of b3d.blocks) {
    const m = /^hit_(road|obj)_(.+)$/i.exec(top.name);
    if (!m) continue;
    room = owners.get(top.name.toLowerCase()) ?? `room_${m[2]}`;
    const box = roomBoxes.get(room.toLowerCase()) ?? null;
    shapes(top, [], box, (p, fence, t, s, tag) => {
      stats[t] = (stats[t] ?? 0) + 1;
      isFence = fence;
      surface = s;
      sw = tag;
      add(p);
      isFence = false;
    });
  }
  // Рівень без обʼєктів колізій `hit_*` (арена Автобола MTB/tb): огорожі (блоки 20) — межі поля й ворота — у
  // верхній групі `$$$Group_3_test` (5). Беремо лише їх; кімната — єдина кімната рівня (у tb — room_tb_000), підлога —
  // з видимої геометрії (groundFromMeshes).
  const rooms = b3d.blocks.filter((b) => b.data.t === 19 && b.name);
  if (!b3d.blocks.some((b) => /^hit_(road|obj)_/i.test(b.name)))
    for (const top of b3d.blocks) {
      if (top.data.t === 19) continue;
      room = rooms.length === 1 ? rooms[0].name : '';
      const box = roomBoxes.get(room.toLowerCase()) ?? null;
      shapes(top, [], box, (p, fence, t, s, tag) => {
        if (t !== 20) return;
        stats[t] = (stats[t] ?? 0) + 1;
        isFence = fence;
        surface = s;
        sw = tag;
        add(p);
        isFence = false;
      });
    }
  return { floors, floorRoom, floorSurface, floorSwitch, walls, wallRoom, wallFence, wallSwitch, hasFloor: floors.length > walls.length / 4, stats };
}

/**
 * Колайдери піддерева: 23 полігони, 20 огорожі, 12 площина (у межах box), 16/17 циліндр; 9 — поділ площиною
 * (обрізає нащадків). emit — полігон (координати блоку), чи огорожа, тип блоку, покриття (`i2` колайдера).
 */
function shapes(top: Block, clip0: Plane[], box: Box | null, emit: (p: Poly, fence: boolean, t: number, surface: number, tag: string) => void): void {
  // sph — сфери-предки (вузол 10), у групі 0 яких лежить вузол: площину 12 обрізаємо ними (див. case 10).
  const visit = (b: Block, clip: Plane[], tag = '', sph: Sphere[] = []): void => {
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
        if (d.shape.kind === 5 && box && d.shape.v[2] > -FLOOR_MIN_NZ) {
          const plane = d.shape.v as Plane;
          emitted = planePatch(plane, box);
          for (const s of sph) emitted = emitted.map((p) => clipAll(p, spherePlanes(plane, s))).filter((p): p is Poly => p !== null);
        }
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
          b.groups[0]?.forEach((c) => visit(c, [...clip, [nx, ny, nz, w]], tag, sph));
          b.groups[1]?.forEach((c) => visit(c, [...clip, [-nx, -ny, -nz, -w]], tag, sph));
          return;
        }
        break;
      case 10:
        // Сфера — поділ простору: група 0 — усередині, 1 — зовні (на всіх ENV/*.b3d: точки полігонів групи 1 — усі
        // поза сферою, групи 0 — усередині, з виступом ≤ 5 м). Полігони 23 лежать на своїх місцях — їх не ріжемо;
        // а нескінченна площина 12 у групі 0 діє лише в сфері (ak_096: майданчик z = 30 радіусом 45 м біля дороги —
        // без обрізання накривав річку, і машина «висіла» над водою).
        if (d.shape.kind === 1 && b.groups) {
          const [x, y, z, r] = d.shape.v;
          b.groups[0]?.forEach((c) => visit(c, clip, tag, [...sph, { c: [x, y, z], r }]));
          b.groups[1]?.forEach((c) => visit(c, clip, tag, sph));
          for (const g of b.groups.slice(2)) for (const c of g) visit(c, clip, tag, sph);
          return;
        }
        break;
      case 21:
        if (b.name && b.groups) {
          const key = b.name.replace(/^refer_/i, '');
          b.groups.forEach((g, gi) => g.forEach((c) => visit(c, clip, `${key}#${gi}`, sph)));
          return;
        }
        break;
    }
    const surface = 'trigger' in d && d.trigger ? d.trigger.i2 : 0;
    for (const p of emitted) {
      const c = clipAll(p, clip);
      if (c) emit(c, d.t === 20, d.t, surface, tag);
    }
    for (const g of b.groups ?? []) for (const c of g) visit(c, clip, tag, sph);
  };
  visit(top, clip0);
}

/** Обʼєкти колізій, розставлені екземплярами (блок 18): склади `store_*_hit*`, заправки `benzo_hit`, СТО `STOS_walls/floor`… */
const INSTANCE_HIT = /hit|^STOS_(walls|floor)$/i;

/**
 * Колізії розставлених екземплярів: будівлі складів, СТО, заправки, аеропорт мають окремі обʼєкти колізій
 * (`store_ap_hit`, `benzo_hit`, `benzo_bottom_hit`, `STOS_walls`, `STOS_floor`), які кімнати ставлять блоком 18 у
 * просторі (блок 24) — як і видимі моделі. Полігони (блок 23) шаблону переводимо матрицею простору в координати гри.
 * find — шаблон за імʼям (регіон, далі COMMON), space — матриця простору (стовпці, як THREE.Matrix4.elements).
 */
export function instanceCollision(
  b3d: B3d,
  find: (name: string) => Block | undefined,
  space: (name: string) => { elements: ArrayLike<number> } | null,
): { floors: Poly[]; floorSurface: number[]; walls: Poly[]; count: number } {
  const floors: Poly[] = [];
  const floorSurface: number[] = [];
  const walls: Poly[] = [];
  let count = 0;
  const cache = new Map<string, [Poly, number][]>();
  const local = (name: string): [Poly, number][] => {
    const key = name.toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    const out: [Poly, number][] = [];
    const tpl = find(name);
    if (tpl) shapes(tpl, [], null, (p, _f, _t, s) => out.push([p, s]));
    cache.set(key, out);
    return out;
  };
  for (const [b] of walk(b3d.blocks)) {
    const d = b.data;
    if (d.t !== 18 || !INSTANCE_HIT.test(d.object)) continue;
    const m = space(d.space)?.elements;
    const polys = local(d.object);
    if (!m || !polys.length) continue;
    count++;
    for (const [p, s] of polys) {
      const q = p.map(([x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]);
      if (Math.abs(normalZ(q)) < FLOOR_MIN_NZ) walls.push(q);
      else {
        floors.push(q);
        floorSurface.push(s);
      }
    }
  }
  return { floors, floorSurface, walls, count };
}

/** Найменший радіус стовпчика `sharp_*`, м: тонший тонкий trimesh корпус на швидкості проскакує. */
const POST_MIN_R = 0.1;
/** Сторін призми стовпчика. */
const POST_SIDES = 8;
/**
 * Стовпчик, верх якого нижче ґрунту + POST_ABOVE, піднімається над ґрунтом щонайменше на стільки, м: точки ніжок
 * щитів (aj) — 0,4…0,6 м над ґрунтом, а корпус машини в порту вищий (king.exe б'є точки об свій корпус `hit_*`).
 */
const POST_ABOVE = 2;
/**
 * Наскільки нижче ґрунту шукати «закопаний» стовпчик, м (у даних здебільшого 1–4 м, поодинокі — до 13 м); більше —
 * ризик підняти стовпчик під мостом на сам міст.
 */
const BURIED_MAX = 4.5;
/** Верхня точка колізії дерева над основою (king.exe 0x64c350; нижня — 0,75, 0x64c330), м. */
const TREE_HIGH = 1.5;

export interface RoomPosts {
  /** Бічні грані стовпчиків (система гри). */
  walls: Poly[];
  /** Кімната кожної грані. */
  wallRoom: string[];
  /** Гілка перемикача (`<Ключ>#<гілка>`) кожної грані; '' — діє завжди. */
  wallSwitch: string[];
  /** Кількість стовпчиків. */
  count: number;
}

/**
 * «Гострі» колізії без подій — блоки 20 `sharp_*` у піддереві кімнат (не в `hit_*`) і в шаблонах, які кімната
 * ставить екземплярами (блок 18: склади `store_*`, СТО `STOS`, `Gorodok`, аеропорт). King.exe
 * бере до 30 таких вузлів кімнати тіла й перевіряє вершини ламаної як кулі радіуса `i2 · 0,01` проти корпусу
 * (0x5855a0 → 0x585150, re/notes/ht2/physics.md «Колізії кімнат»). У даних це майже завжди вертикальні стовпчики —
 * 2–3 точки на одній вертикалі: ніжки рекламних щитів, щогли, стовпи огорож `sharp_fence_`, навісів складів.
 * Порт робить із кожної вертикалі восьмигранну призму від нижньої до верхньої кулі.
 * Збивні `e_*` (знаки, світлофори, радари, ліхтарі, вказівники міст) і рухомі `AnmObj*` — у world/objects.ts.
 * keys — ключі перемикачів, гілки яких мають власні колізії (з `hit_*`); під іншими перемикачами (освітлення,
 * світлофори) стовпчик діє завжди.
 */
export function roomPosts(
  b3d: B3d,
  find: (name: string) => Block | undefined,
  space: (name: string) => { elements: ArrayLike<number> } | null,
  keys: ReadonlySet<string> = new Set(),
  ground: ((x: number, y: number, z: number, room: string) => number | null) | null = null,
): RoomPosts {
  const out: RoomPosts = { walls: [], wallRoom: [], wallSwitch: [], count: 0 };
  const seen = new Set<string>();
  const emit = (pts: readonly number[][], radius: number, room: string, tag: string, lift = true) => {
    for (const p of posts(pts, radius, ground && lift ? (x, y, z) => ground(x, y, z, room) : null)) {
      out.count++;
      for (const w of p) {
        out.walls.push(w);
        out.wallRoom.push(room);
        out.wallSwitch.push(tag);
      }
    }
  };
  const visit = (b: Block, room: string, tag: string, m: ArrayLike<number> | null, depth: number): void => {
    const d = b.data;
    if (d.t === 20 && /^sharp/i.test(b.name) && d.trigger.values.length <= 1) {
      const pts = m ? d.points.map(([x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]) : d.points;
      emit(pts, d.trigger.i2 * 0.01, room, tag);
      return;
    }
    // Дерево з бітом 1 `i1`: king.exe сам ставить у кімнату вузол `sharpTerrainTree` — дві точки над основою (центр
    // сфери, на землі) на 0,75 і 1,5 м, точковий тест проти корпусу (0x5c8ae0 → 0x5c85a0, re/notes/ht2/trees.md).
    if (d.t === 40 && d.name2 === '$$TreeGenerator1' && d.i1 & 2 && d.bound[3] > 0 && !m) {
      const [x, y, z] = d.bound;
      // Порт — стовбур від ґрунту до POST_ABOVE (корпус машини в порту вищий за корпус king.exe, як у стовпчиків).
      emit([[x, y, z - 0.5 + POST_MIN_R], [x, y, z + Math.max(TREE_HIGH, POST_ABOVE) - POST_MIN_R]], 0, room, tag, false);
      return;
    }
    if (d.t === 18 && depth < 4 && !/^(anmobj|e_)|hit/i.test(d.object)) {
      const key = `${room}|${d.space}|${d.object}`.toLowerCase();
      const tpl = find(d.object);
      const sm = space(d.space)?.elements ?? null;
      if (tpl && sm && !seen.has(key)) {
        seen.add(key);
        visit(tpl, room, tag, sm, depth + 1);
      }
      return;
    }
    if (d.t === 21 && b.groups) {
      const k = b.name.replace(/^refer_/i, '');
      b.groups.forEach((g, gi) => g.forEach((c) => visit(c, room, keys.has(k) ? `${k}#${gi}` : tag, m, depth)));
      return;
    }
    for (const g of b.groups ?? []) for (const c of g) visit(c, room, tag, m, depth);
  };
  for (const top of b3d.blocks) if (top.data.t === 19) visit(top, top.name, '', null, 0);
  return out;
}

/** Висота підлоги (`hit_road`) своєї кімнати під точкою — для `roomPosts`; підлогу розкладено по кімнатах один раз. */
export function roomGround(col: Pick<LevelCollision, 'floors' | 'floorRoom'>): (x: number, y: number, z: number, room: string) => number | null {
  const by = new Map<string, { floors: Poly[]; floorRoom: string[] }>();
  col.floors.forEach((p, i) => {
    const r = col.floorRoom[i].toLowerCase();
    const g = by.get(r) ?? by.set(r, { floors: [], floorRoom: [] }).get(r)!;
    g.floors.push(p);
    g.floorRoom.push(r);
  });
  return (x, y, z, room) => {
    const g = by.get(room.toLowerCase());
    return g ? (floorAt(g, x, y, z)?.z ?? null) : null;
  };
}

/**
 * Точки ламаної `sharp_*` → призми: точки на одній вертикалі — один стовпчик від нижньої до верхньої кулі.
 * ground — висота підлоги під стовпчиком. Низькі стовпчики (ніжки щитів у aj — точки 0,4…0,6 м над ґрунтом) і ≈ 150
 * нижчих за ґрунт `hit_road` (огорожі ab) порт піднімає на POST_ABOVE над ґрунтом — щоб їх зачіпав корпус машини.
 */
function posts(points: readonly number[][], radius: number, ground: ((x: number, y: number, z: number) => number | null) | null): Poly[][] {
  const r = Math.max(POST_MIN_R, radius);
  const cols: { x: number; y: number; z0: number; z1: number }[] = [];
  for (const [x, y, z] of points) {
    const c = cols.find((q) => Math.hypot(q.x - x, q.y - y) < 0.05);
    if (c) {
      c.z0 = Math.min(c.z0, z);
      c.z1 = Math.max(c.z1, z);
    } else cols.push({ x, y, z0: z, z1: z });
  }
  return cols.map(({ x, y, z0, z1 }) => {
    let lo = z0 - r;
    let hi = z1 + r;
    const g = ground?.(x, y, z1 + BURIED_MAX);
    if (g != null && hi < g + POST_ABOVE) {
      lo = Math.min(lo, g - 0.5);
      hi = g + POST_ABOVE;
    }
    const at = (i: number) => {
      const a = (2 * Math.PI * i) / POST_SIDES;
      return [x + Math.cos(a) * r, y + Math.sin(a) * r];
    };
    const sides: Poly[] = [];
    for (let i = 0; i < POST_SIDES; i++) {
      const [p, q] = [at(i), at(i + 1)];
      sides.push([[p[0], p[1], lo], [q[0], q[1], lo], [q[0], q[1], hi], [p[0], p[1], hi]]);
    }
    return sides;
  });
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
  const switches: string[] = [];
  col.walls.forEach((w, i) => {
    const keep = (p: Poly, fence: boolean) => {
      walls.push(p);
      rooms.push(col.wallRoom[i]);
      fences.push(fence);
      switches.push(col.wallSwitch[i]);
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
  col.wallSwitch = switches;
  return cut;
}

/**
 * Вертикальна огорожа вздовж відрізка ламаної. King.exe перевіряє огорожу лише на плані — z точок обнуляє, стіна без
 * верху й низу (0x5f6820 → 0x5f5a80, re/notes/ht2/physics.md «Колізії кімнат»). Тож огорожа кімнати — стіна на всю
 * висоту кімнати, хоч би на якій висоті лежали точки: межі з нульовою висотою (dr, COUNT) інакше опинялися під
 * землею, а межі на схилах (av_003 — точки на 30–50 м над дорогою на 20 м, ar_026 — на 30 м біля дороги на 31 м)
 * були смугою «точки −1…+3 м», яку машина проминала схилом знизу чи згори, виїжджала за край світу й падала. Без
 * кімнати (шаблони екземплярів) — смуга довкола точок.
 */
function fence(a: number[], b: number[], box: Box | null): Poly {
  if (box) {
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

/**
 * Чия колізія `hit_*`: кімната (блок 19) посилається на неї вузлом 5 (`road_XXX`/`obj_XXX`, поле `name1`), як читає
 * king.exe (re/notes/ht2/physics.md «Колізії кімнат»). Імена зазвичай збігаються, але не завжди: у cb `room_cb15` →
 * `hit_road_cb15a` — за іменем підлога діставалась неіснуючій кімнаті без порталів, і на межах із сусідами колеса
 * її не бачили (машина провалювалась). Ключ — імʼя `hit_*` малими літерами.
 */
export function hitOwners(b3d: B3d): Map<string, string> {
  const out = new Map<string, string>();
  for (const room of b3d.blocks) {
    if (room.data.t !== 19) continue;
    for (const [blk] of walk([room])) {
      const d = blk.data;
      if (d.t === 5 && /^hit_/i.test(d.name1)) out.set(d.name1.toLowerCase(), room.name);
    }
  }
  return out;
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

interface Sphere {
  c: number[];
  r: number;
}

/** Кількість сторін многокутника, описаного навколо кола перетину площини зі сферою. */
const SPHERE_SIDES = 24;

/**
 * Межі кола, по якому площина `n·p + d = 0` перетинає сферу: SPHERE_SIDES площин, перпендикулярних до неї (описаний
 * многокутник — не менший за коло). Площина сфери не перетинає — площина, що відкидає все.
 */
function spherePlanes([nx, ny, nz, d]: Plane, s: Sphere): Plane[] {
  const len = Math.hypot(nx, ny, nz);
  if (!len) return [];
  const n = [nx / len, ny / len, nz / len];
  const dist = n[0] * s.c[0] + n[1] * s.c[1] + n[2] * s.c[2] + d / len;
  if (Math.abs(dist) >= s.r) return [[0, 0, 0, -1]];
  const o = [0, 1, 2].map((k) => s.c[k] - n[k] * dist);
  const rho = Math.sqrt(s.r * s.r - dist * dist) / Math.cos(Math.PI / SPHERE_SIDES);
  const u = Math.abs(n[2]) < 0.9 ? normalize(cross(n, [0, 0, 1])) : normalize(cross(n, [1, 0, 0]));
  const v = cross(n, u);
  const out: Plane[] = [];
  for (let i = 0; i < SPHERE_SIDES; i++) {
    const a = (2 * Math.PI * i) / SPHERE_SIDES;
    const e = [0, 1, 2].map((k) => u[k] * Math.cos(a) + v[k] * Math.sin(a));
    // Лишаємо e·p ≤ e·o + rho, тобто −e·p + (e·o + rho) ≥ 0.
    out.push([-e[0], -e[1], -e[2], e[0] * o[0] + e[1] * o[1] + e[2] * o[2] + rho]);
  }
  return out;
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

import * as THREE from 'three';
import type { Ht2Drive } from './drive';
import type { NetStart } from './ui/netScreens';
import { netTime, showNetResult } from './ui/netResults';
import { FIRST_RIVAL, PLAYER_COLORS } from './net/state';
import { AllyLedger, applyOp, dayOffset, memberOf, stateOf } from './career/allies';

/** Скільки господар чекає, поки всі завантажать трасу, мс (далі — старт без запізнілих). */
const NET_READY_TIMEOUT = 30000;
/** Маркер гравця над машиною: висота над дахом, м; розмір — частка висоти екрана (спрайт сталого розміру). */
const MARKER_LIFT = 1.5;
const MARKER_SIZE = 0.06;

export interface NetDriveEvents {
  /** Сервер почав новий заїзд (ми ще на трасі) — їхати за ним. */
  onRestart(start: NetStart): void;
  /** Назад до сесії (кнопка таблиці фінішу). */
  onLobby(): void;
}

/**
 * Звʼязати мережевий заїзд HT2 із сесією (як joinNetDrive першої гри): свій стан — іншим (Ht2Drive.onNetState),
 * їхні — машинам з мережі (RaceMode.pushFleet); спільний старт — світлофор тримається, доки всі не завантажать трасу,
 * старт дає господар; фініш і таблиця; гравці праворуч і маркери над їхніми машинами. Повертає прибирання.
 */
export function joinNetDrive(d: Ht2Drive, net: NetStart, driver: string, ev: NetDriveEvents): () => void {
  const race = d.race;
  const { session } = net;
  const me = session.myId;
  if (!race) return () => {};
  const names = new Map(net.players.map((p) => [p.id, p.id === me ? driver : p.name]));
  const nameOf = (id: number) => names.get(id) ?? `Водій ${id + 1}`;
  d.onNetState = (data) => session.sendFast(data);

  // Гравці праворуч і маркери над машинами інших гравців (колір за номером, PLAYER_COLORS).
  const roster = playerRoster(d, net, me, nameOf);
  for (const r of race.racers) if (r.remote && r.id !== undefined && r.id < FIRST_RIVAL) r.truck.visual.add(playerMarker(PLAYER_COLORS[r.id] ?? '#fff', r.truck.visual));

  const gone = new Set<number>();
  /** Рядок гравця в списку праворуч: зв'язок завис — блідий, з «…». */
  const markStalled = (id: number, stalled: boolean) => roster.querySelector(`[data-id="${id}"]`)?.classList.toggle('stalled', stalled);
  const leave = (id: number, text: string) => {
    if (gone.has(id)) return;
    gone.add(id);
    d.say(`${nameOf(id)}: ${text}`, 4);
    // Пішов сервер — разом з ним зникають і його суперники.
    race.remoteGone(id === 0 ? undefined : (x) => x === id);
    roster.querySelector(`[data-id="${id}"]`)?.classList.add('gone');
  };

  // Спільний старт: світлофор чекає на червоному, доки всі не завантажать трасу; старт дає господар.
  race.hold = true;
  if (!session.host) session.send({ t: 'ready', id: me });
  const go = () => {
    if (!race.hold) return;
    race.hold = false;
    if (session.host) session.send({ t: 'go' });
  };
  const tryGo = () => {
    if (session.host && [...session.players.keys()].every((id) => session.ready.has(id) || gone.has(id))) go();
  };
  const readyTimer = session.host ? window.setTimeout(go, NET_READY_TIMEOUT) : 0;

  // Результати (king.exe 0x574530): Кільце й Тріал — ті, хто фінішував, за часом; Автобол — за очками. Перший — свій
  // гравець: youwinSound і BackWin1/2, інакше youlostSound і BackLoose3/4 (ui/netResults.ts). Фініш інших — дописується.
  d.netNames = new Map(names);
  let result: ReturnType<typeof showNetResult> | null = null;
  const rows = () => {
    const all = race.netRows(d.netNames);
    return race.kind === 'ball' ? all : all.filter((r) => r.value !== '—');
  };
  const showResult = () => {
    if (result) return;
    const list = rows();
    const won = list[0]?.id === me;
    d.playSound(won ? 'youwin' : 'youlost');
    result = showNetResult(d.escArt, d.overlay, { ball: race.kind === 'ball', won, rows: list }, () => ev.onLobby());
  };
  race.onNetFinish = (time, place) => {
    if (result) return;
    session.send({ t: 'finish', time, place, id: me });
    showResult();
  };
  // Автобол: голи рахує сервер і розсилає (0x3B9); 1000 очок — кінець гри для всіх (0x3B8).
  race.onBallGoal = (id, gate, total) => {
    if (session.host) session.send({ t: 'goal', id, gate, total });
  };
  race.onBallOver = () => showResult();
  session.events = {
    onFast: (data) => race.pushFleet(data),
    // Гравець зник зі списку господаря (відключився) — його машину прибрати (у господаря — onLeave).
    onChange: () => {
      for (const p of net.players) if (p.id !== me && !session.players.has(p.id)) leave(p.id, 'з’єднання закрито');
      // Чий зв'язок із сервером завис — бачать усі (поле stalled у списку від сервера).
      for (const p of session.players.values()) if (p.id !== me) markStalled(p.id, !!p.stalled);
    },
    // Зв'язок завис — не кінець (М5): WebRTC відновлюється сам; чекаємо до LOST_AFTER, тоді — onLeave.
    onStall: (id, stalled) => {
      markStalled(id, stalled);
      const who = id === 0 && !session.host ? 'ЗВʼЯЗОК ІЗ СЕРВЕРОМ' : `${nameOf(id)}: ЗВʼЯЗОК`;
      d.say(stalled ? `${who} ПЕРЕРВАНО, ЧЕКАЄМО…` : `${who} ВІДНОВЛЕНО`, 4);
    },
    onMessage: (m) => {
      switch (m.t) {
        case 'start':
          ev.onRestart({ session, setup: m.setup, players: m.players, rivals: m.rivals, ally: m.ally });
          return;
        case 'go':
          go();
          return;
        case 'goal':
          race.netGoal(m.id, m.gate, m.total);
          return;
        case 'ready':
          tryGo();
          return;
        case 'lobby':
          leave(m.id, 'повернувся до сесії');
          tryGo();
          return;
        case 'finish':
          race.netFinished(m.id, m.time);
          if (result) result.update({ ball: false, won: rows()[0]?.id === me, rows: rows() });
          else d.say(`${nameOf(m.id)} фінішував: ${netTime(m.time)}`, 5);
          return;
      }
    },
    onLeave: (id) => {
      leave(id, 'з’єднання закрито');
      if (id === 0) go();
      else tryGo();
    },
  };
  tryGo();
  return () => {
    clearTimeout(readyTimer);
    session.events = {};
    roster.remove();
    result?.close();
    d.onNetState = null;
  };
}

/** Список гравців праворуч «імʼя ■» кольором гравця (власний елемент порту, як у першій грі). */
function playerRoster(d: Ht2Drive, net: NetStart, me: number, nameOf: (id: number) => string): HTMLElement {
  const roster = document.createElement('div');
  roster.className = 'ht2-net-roster';
  for (const p of [...net.players].sort((a, b) => a.id - b.id)) {
    const row = document.createElement('div');
    row.dataset.id = String(p.id);
    if (p.id === me) row.className = 'me';
    const name = document.createElement('span');
    name.textContent = nameOf(p.id);
    const sq = document.createElement('i');
    sq.style.background = PLAYER_COLORS[p.id] ?? '#fff';
    row.append(name, sq);
    roster.append(row);
  }
  d.overlay.append(roster);
  return roster;
}

/** Як часто гравець мережевої кар'єри шле свій флот (king.exe перераховує частку X раз на 8 с, 0x41fcf0), мс. */
const STAND_EVERY = 8000;
/** Як часто сервер мережевої кар'єри розсилає годинник і погоду, мс. */
const CLOCK_EVERY = 3000;
/** Союзники: як часто гість збирає свої зміни компанії і як часто сервер розсилає її стан, мс. */
const ALLY_OP_EVERY = 400;
const ALLY_STATE_EVERY = 1500;
/** Союзники: як часто гість шле серверу своє особисте (машина, замовлення, позиція) для збереження, мс. */
const ALLY_MEMBER_EVERY = 10000;

/**
 * Мережева кар'єра (М6, «змагання за ринок» — власний режим порту): кожен у своїй кар'єрі в одному світі. Свій стан
 * машини — іншим (NetCars), флот раз на 8 с (`stand`) — спільна частка ринку й F2; узяв замовлення на місці складу —
 * `taken` (в інших місце порожнє); захопив ринок (X ≥ 0,51) — `won`, у решти кінець гри BackLoose1. Повертає
 * прибирання.
 */
export function joinNetCareer(d: Ht2Drive, net: NetStart, driver: string, ev: NetDriveEvents): () => void {
  const cm = d.careerMode;
  const cars = d.netCars;
  const { session } = net;
  const me = session.myId;
  if (!cm || !cars) return () => {};
  const names = new Map(net.players.map((p) => [p.id, p.id === me ? driver : p.name]));
  const nameOf = (id: number) => names.get(id) ?? `Водій ${id + 1}`;
  d.netNames = new Map(names);
  d.onNetState = (data) => session.sendFast(data);
  const roster = playerRoster(d, net, me, nameOf);
  for (const c of cars.cars) c.truck.visual.add(playerMarker(PLAYER_COLORS[c.id] ?? '#fff', c.truck.visual));
  cm.netOthers = new Map();
  const stand = () => session.send({ t: 'stand', id: me, ...cm.standing() });
  stand();
  const standTimer = window.setInterval(stand, STAND_EVERY);
  // Доба й погода — сервера (суперництво: лише година доби, свої дата й строки; союзники — спільний час компанії).
  const allies = net.setup.career === 'allies';
  const clock = () => session.send({ t: 'clock', time: cm.career.time, ...d.weatherState });
  const clockTimer = session.host ? window.setInterval(clock, CLOCK_EVERY) : 0;
  if (session.host) clock();
  // Союзники (career/allies.ts): сервер веде компанію, гість шле зміни й особисте.
  const timers: number[] = [];
  const acks: Record<number, number> = {};
  const ledger = allies && !session.host && net.ally ? new AllyLedger(net.ally.state) : null;
  const sendState = () => session.send({ t: 'allyState', state: stateOf(cm.career, acks) });
  if (allies) {
    cm.allies = session.host ? 'host' : 'guest';
    if (session.host) {
      cm.career.allies ??= {};
      timers.push(window.setInterval(sendState, ALLY_STATE_EVERY));
      sendState();
    } else {
      cm.onAllyPersist = () => session.send({ t: 'allyMember', id: me, name: driver, member: memberOf(cm.career) });
      timers.push(
        window.setInterval(() => {
          const op = ledger?.collect(cm.career);
          if (op) session.send({ t: 'allyOp', id: me, op });
        }, ALLY_OP_EVERY),
        window.setInterval(() => cm.persist(), ALLY_MEMBER_EVERY),
      );
    }
  }
  cm.onOrderTaken = (store, dock) => session.send({ t: 'taken', id: me, store, dock });
  d.onNetVictory = () => session.send({ t: 'won', id: me });
  const gone = new Set<number>();
  const markStalled = (id: number, stalled: boolean) => roster.querySelector(`[data-id="${id}"]`)?.classList.toggle('stalled', stalled);
  const leave = (id: number, text: string) => {
    if (gone.has(id)) return;
    gone.add(id);
    d.say(`${nameOf(id)}: ${text}`, 4);
    cars.remoteGone((x) => x === id);
    // Вийшов — його флот більше не в частці ринку.
    cm.netOthers?.delete(id);
    roster.querySelector(`[data-id="${id}"]`)?.classList.add('gone');
  };
  session.events = {
    onFast: (data) => cars.pushFleet(data),
    onChange: () => {
      for (const p of net.players) if (p.id !== me && !session.players.has(p.id)) leave(p.id, 'з’єднання закрито');
      for (const p of session.players.values()) if (p.id !== me) markStalled(p.id, !!p.stalled);
    },
    onStall: (id, stalled) => {
      markStalled(id, stalled);
      const who = id === 0 && !session.host ? 'ЗВʼЯЗОК ІЗ СЕРВЕРОМ' : `${nameOf(id)}: ЗВʼЯЗОК`;
      d.say(stalled ? `${who} ПЕРЕРВАНО, ЧЕКАЄМО…` : `${who} ВІДНОВЛЕНО`, 4);
    },
    onMessage: (m) => {
      switch (m.t) {
        case 'stand':
          if (!gone.has(m.id)) cm.netOthers?.set(m.id, { name: nameOf(m.id), load: m.load, hired: m.hired, tons: m.tons });
          return;
        case 'taken':
          cm.blockDock(m.store, m.dock, nameOf(m.id));
          return;
        case 'won':
          // Союзники — одна компанія: перемогу бачить кожен сам (частка та сама, won — у стані компанії).
          if (allies) return;
          d.say(`${nameOf(m.id)} ЗАХОПИВ РИНОК`, 6);
          d.netDefeat();
          return;
        case 'clock':
          if (allies) cm.career.time = m.time;
          else d.dayOffset = dayOffset(m.time, cm.career.time);
          d.setWeatherState(m.th1, m.th2);
          return;
        case 'allyState':
          ledger?.receive(cm.career, m.state, me);
          return;
        case 'allyOp':
          if (allies && session.host && applyOp(cm.career, acks, m.id, m.op)) sendState();
          return;
        case 'allyMember':
          if (allies && session.host) {
            (cm.career.allies ??= {})[m.name] = m.member;
            cm.persist();
          }
          return;
        case 'start':
          ev.onRestart({ session, setup: m.setup, players: m.players, rivals: m.rivals, ally: m.ally });
          return;
        case 'lobby':
          leave(m.id, 'повернувся до сесії');
          return;
      }
    },
    onLeave: (id) => leave(id, 'з’єднання закрито'),
  };
  return () => {
    clearInterval(standTimer);
    clearInterval(clockTimer);
    timers.forEach((t) => clearInterval(t));
    // Гість-союзник іде — останні зміни й особисте серверу (поки зʼєднання живе).
    if (ledger && !session.closed) {
      const op = ledger.collect(cm.career);
      if (op) session.send({ t: 'allyOp', id: me, op });
      cm.persist();
    }
    session.events = {};
    roster.remove();
    d.onNetState = null;
    d.onNetVictory = null;
    cm.onOrderTaken = null;
    cm.onAllyPersist = null;
  };
}

/** Маркер гравця над машиною: трикутник вершиною вниз його кольору з темним контуром; сталого розміру, без туману. */
function playerMarker(color: string, visual: THREE.Object3D): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.moveTo(8, 10);
  g.lineTo(56, 10);
  g.lineTo(32, 54);
  g.closePath();
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.stroke();
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), fog: false, sizeAttenuation: false, depthWrite: false }));
  sprite.name = 'net-marker';
  sprite.scale.setScalar(MARKER_SIZE);
  sprite.renderOrder = 5;
  // Над найвищою точкою видимої моделі (у системі visual, без повороту машини).
  visual.updateMatrixWorld(true);
  const inv = visual.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  visual.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld.clone().premultiply(inv)));
  });
  sprite.position.set(0, (box.isEmpty() ? 3 : Math.min(box.max.y, 6)) + MARKER_LIFT, 0);
  return sprite;
}

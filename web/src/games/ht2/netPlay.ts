import * as THREE from 'three';
import type { Ht2Drive } from './drive';
import type { NetStart } from './ui/netScreens';
import { carName } from './ui/netScreens';
import { FIRST_RIVAL, PLAYER_COLORS } from './net/state';
import { modal } from './engine/ui/modal';

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

/** Час заїзду: хв:сс,д. */
export function raceTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1).replace('.', ',')}`;
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
  for (const r of race.racers) if (r.remote && r.id !== undefined && r.id < FIRST_RIVAL) r.truck.visual.add(playerMarker(PLAYER_COLORS[r.id] ?? '#fff', r.truck.visual));

  const gone = new Set<number>();
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

  // Результати: час кожного від зеленого (старт одночасний) і місце, яке порахував його телефон.
  const results = new Map<number, { time: number; place: number }>();
  let table: HTMLElement | null = null;
  const renderTable = () => {
    if (!table) return;
    const rows = net.players
      .map((p) => ({ who: nameOf(p.id), car: carName(p.truck), r: results.get(p.id) ?? null, gone: gone.has(p.id) }))
      .sort((a, b) => (a.r?.time ?? Infinity) - (b.r?.time ?? Infinity));
    table.textContent = rows.map((x, i) => (x.r ? `${i + 1}. ${x.who} (${x.car}) — ${raceTime(x.r.time)}` : `—. ${x.who} — ${x.gone ? 'вийшов' : 'ще їде'}`)).join('\n');
  };
  race.onNetFinish = (time, place) => {
    if (table) return;
    results.set(me, { time, place });
    session.send({ t: 'finish', time, place, id: me });
    table = document.createElement('div');
    table.className = 'ht2-net-results';
    renderTable();
    void modal(d.overlay, 'Фініш', table, ['До сесії']).then(() => ev.onLobby());
  };
  // Автобол: голи рахує сервер і розсилає (0x3B9); 1000 очок — кінець гри для всіх (0x3B8) — таблиця за очками.
  race.onBallGoal = (id, gate, total) => {
    if (session.host) session.send({ t: 'goal', id, gate, total });
  };
  race.onBallOver = (scores) => {
    if (table) return;
    table = document.createElement('div');
    table.className = 'ht2-net-results';
    table.textContent = scores.map((s, i) => `${i + 1}. ${nameOf(s.id)} — $${s.points}`).join('\n');
    // Перший — свій гравець: youwinSound, інакше youlostSound (0x574530).
    d.playSound(scores[0]?.id === me ? 'youwin' : 'youlost');
    void modal(d.overlay, 'Автобол', table, ['До сесії']).then(() => ev.onLobby());
  };
  session.events = {
    onFast: (data) => race.pushFleet(data),
    // Гравець зник зі списку господаря (відключився) — його машину прибрати (у господаря — onLeave).
    onChange: () => {
      for (const p of net.players) if (p.id !== me && !session.players.has(p.id)) leave(p.id, 'з’єднання закрито');
    },
    onMessage: (m) => {
      switch (m.t) {
        case 'start':
          ev.onRestart({ session, setup: m.setup, players: m.players, rivals: m.rivals });
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
          results.set(m.id, { time: m.time, place: m.place });
          race.netFinished(m.id, m.time);
          if (table) renderTable();
          else d.say(`${nameOf(m.id)} фінішував: ${raceTime(m.time)}`, 5);
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
    d.onNetState = null;
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

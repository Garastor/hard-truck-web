import { el } from '../engine/ui/modal';

/**
 * Налаштування вільної їзди (кнопка-шестерня поруч із «☰», на прохання користувача; в оригіналі такого меню немає):
 * вікно в стилі технічних вікон порту з випадними списками. Зміна списку діє одразу; `close` — після дії, що
 * закриває вікно (телепорт).
 */
export interface FreeOption {
  value: string;
  label: string;
}

export interface FreeField {
  label: string;
  options: FreeOption[];
  /** Поточне значення; '' — підказка «обрати» (дії без стану, як телепорт). */
  value(): string;
  set(value: string): void;
  /** Після вибору закрити вікно. */
  closes?: boolean;
}

/** Назви машин для списку (з поля name vehicle.tech; власні — для впізнаваних). */
const VEHICLE_NAMES: Record<string, string> = {
  GAZELLE: 'Газель',
  GAZELLE_1C: 'Газель 1С',
  OFFROAD: 'Позашляховик',
  PICKUP: 'Пікап',
  PATROL: 'Nissan Patrol',
  CAYMAN: 'Cayman (мафія)',
  BMW_M5: 'BMW M5',
  BMW_M5police: 'BMW M5 (міліція)',
  BUS: 'Автобус',
  VAN: 'Фургон',
  OKA: 'Ока',
  VOLGA: 'Волга',
  SOBOL: 'Соболь',
  ZIL: 'ЗіЛ',
  KAMAZ: 'КамАЗ',
  STORM: 'Шторм',
  DAF: 'DAF',
};

export function vehicleName(name: string): string {
  return VEHICLE_NAMES[name] ?? name.charAt(0) + name.slice(1).toLowerCase().replace(/_/g, ' ');
}

export const GEAR_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" fill-rule="evenodd"><path d="M10.3 2h3.4l.5 2.6a8 8 0 0 1 1.9.8l2.2-1.5 2.4 2.4-1.5 2.2c.3.6.6 1.2.8 1.9l2.6.5v3.4l-2.6.5a8 8 0 0 1-.8 1.9l1.5 2.2-2.4 2.4-2.2-1.5a8 8 0 0 1-1.9.8l-.5 2.6h-3.4l-.5-2.6a8 8 0 0 1-1.9-.8l-2.2 1.5-2.4-2.4 1.5-2.2a8 8 0 0 1-.8-1.9L2 13.7v-3.4l2.6-.5c.2-.7.5-1.3.8-1.9L3.9 5.7l2.4-2.4 2.2 1.5c.6-.3 1.2-.6 1.9-.8zM12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z"/></svg>';

/** Відкрити вікно; повертає функцію закриття. onClose — після будь-якого закриття. */
export function openFreeSettings(overlay: HTMLElement, fields: FreeField[], onClose: () => void): () => void {
  const back = el('div', 'career-modal ht2-free');
  const box = el('div', 'career-box');
  box.append(el('h2', undefined, 'Налаштування вільної їзди'));
  const form = el('div', 'career-form');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    back.remove();
    onClose();
  };
  for (const f of fields) {
    const label = el('label');
    label.append(el('span', undefined, f.label));
    const sel = el('select');
    const cur = f.value();
    if (cur === '') {
      const o = el('option', undefined, '— обрати —');
      o.value = '';
      sel.append(o);
    }
    for (const opt of f.options) {
      const o = el('option', undefined, opt.label);
      o.value = opt.value;
      sel.append(o);
    }
    sel.value = cur;
    sel.addEventListener('change', () => {
      if (sel.value === '') return;
      f.set(sel.value);
      if (f.closes) close();
    });
    label.append(sel);
    form.append(label);
  }
  box.append(form);
  const row = el('div', 'career-actions');
  const ok = el('button', 'hud-btn primary', 'Закрити');
  ok.addEventListener('click', close);
  row.append(ok);
  box.append(row);
  back.append(box);
  // Дотик поза вікном закриває його.
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  window.addEventListener('keydown', onKey, true);
  overlay.append(back);
  return close;
}

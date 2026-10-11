/** Кабіна: 3D-модель машини чи 2D-кабіна (растр panel_mask, як у програмному режимі оригіналу). */
export type CabStyle = '3d' | '2d';
const CAB_KEY = 'ht.cabStyle';

export function cabStyle(): CabStyle {
  try {
    return localStorage.getItem(CAB_KEY) === '2d' ? '2d' : '3d';
  } catch {
    return '3d';
  }
}

export function setCabStyle(style: CabStyle): void {
  try {
    localStorage.setItem(CAB_KEY, style);
  } catch {
    /* приватний режим — лише на цей заїзд */
  }
}

/** Вид з кабіни: повна кабіна машини чи спільна приладова панель (налаштування, зберігається в браузері). */
export type CabMode = 'full' | 'panel';
const CAB_KEY = 'ht.cab';
export function cabMode(): CabMode {
  try {
    return localStorage.getItem(CAB_KEY) === 'panel' ? 'panel' : 'full';
  } catch {
    return 'full';
  }
}
export function setCabMode(mode: CabMode): void {
  try {
    localStorage.setItem(CAB_KEY, mode);
  } catch {
    /* приватний режим — лише на цей заїзд */
  }
}

/**
 * Масштаб інтерфейсу оболонки (копія правила ігор, щоб оболонка не залежала від їхнього коду): табло — 1× на
 * телефоні в ландшафті, на великому екрані — кратне 400 px висоти на 20 % менше; малий екран — менше 1×.
 */
export function hudScale(): number {
  const s = Math.max(1, Math.floor(window.innerHeight / 400));
  return s > 1 ? s * 0.8 : uiScale();
}

/** Зменшення інтерфейсу для малих екранів (менше 800×375 CSS px): 1 — без зменшення. */
export function uiScale(): number {
  return Math.max(0.6, Math.min(1, window.innerWidth / 800, window.innerHeight / 375));
}

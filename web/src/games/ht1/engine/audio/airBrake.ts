/**
 * Пневмогальма — власний звук порту (на прохання користувача; в оригінальній першій грі звуку пневмогальм немає,
 * у другій — pss/pss2 з king.exe, їх не копіюємо): клапан «чк-чк» на натисканні гальма і скидання повітря «пшш»
 * на відпусканні. Звук генерується тут же з шуму — файлів немає. Рецепт затверджено на слух (варіанти air4_b —
 * клапан, air7_a — повітря): білий шум, пофарбований у частотній області (смуги з пологими схилами), × обвідна.
 */

/** Смуга lo…hi з пологими схилами, дБ на октаву. */
function band(lo: number, hi: number, slope: number): (f: number) => number {
  return (f) => {
    const x = Math.max(f, 1);
    return (x < lo ? -slope * Math.log2(lo / x) : 0) + (x > hi ? -slope * Math.log2(x / hi) : 0);
  };
}

/** Комплексне FFT на місці (radix-2), inverse — обернене без нормування. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Білий шум довжини n, пофарбований: амплітуда частоти f × 10^(gainDb(f)/20); нормований до піку 1. */
function colored(n: number, rate: number, gainDb: (f: number) => number): Float64Array {
  let size = 1;
  while (size < n) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    // Нормальний шум (Бокс — Мюллер).
    re[i] = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  }
  fft(re, im, false);
  for (let k = 0; k <= size / 2; k++) {
    const g = 10 ** (gainDb((k * rate) / size) / 20);
    re[k] *= g;
    im[k] *= g;
    if (k > 0 && k < size / 2) {
      re[size - k] *= g;
      im[size - k] *= g;
    }
  }
  fft(re, im, true);
  return normalize(re.subarray(0, n));
}

function normalize(x: Float64Array): Float64Array {
  let peak = 1e-9;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < x.length; i++) x[i] /= peak;
  return x;
}

/** Обвідна: наростання attack с від t0, далі експоненційне загасання з постійною decay с. */
function env(t: number, t0: number, attack: number, decay: number): number {
  if (t < t0) return 0;
  const d = t - t0;
  return Math.min(1, d / attack) * Math.exp(-d / decay);
}

/** Плавне згасання останніх 30 мс і пік 0,85. */
function finish(x: Float64Array, rate: number): Float32Array<ArrayBuffer> {
  const fade = 0.03 * rate;
  for (let i = 0; i < x.length; i++) x[i] *= Math.min(1, (x.length - i) / fade);
  normalize(x);
  return Float32Array.from(x, (v) => v * 0.85);
}

/**
 * Клапан: два глухі удари корпусу (45…300 Гц, загасання 80 мс) з легким металевим призвуком (700…2000 Гц, 12 мс),
 * на 20 і 90 мс, другий — 0,65 від першого.
 */
export function airValve(rate: number): Float32Array<ArrayBuffer> {
  const n = Math.round(0.4 * rate);
  const y = new Float64Array(n);
  for (const [t0, amp] of [[0.02, 1], [0.09, 0.65]]) {
    const body = colored(n, rate, band(45, 300, 24));
    const knock = colored(n, rate, band(700, 2000, 24));
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      y[i] += amp * (body[i] * env(t, t0, 0.002, 0.08) + 0.18 * knock[i] * env(t, t0, 0.001, 0.012));
    }
  }
  return finish(y, rate);
}

/** Скидання повітря: рівний широкий шум 600…7000 Гц (схили 9 дБ/окт) + «тіло» 120…900 Гц, загасання 0,17 с. */
export function airRelease(rate: number): Float32Array<ArrayBuffer> {
  const n = Math.round(0.95 * rate);
  const hiss = colored(n, rate, band(600, 7000, 9));
  const low = colored(n, rate, band(120, 900, 12));
  const y = new Float64Array(n);
  const tau = 0.17;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    y[i] = (hiss[i] + 0.5 * low[i] * Math.exp(-t / (tau * 0.7))) * env(t, 0, 0.012, tau);
  }
  return finish(y, rate);
}

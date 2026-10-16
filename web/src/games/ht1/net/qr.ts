/**
 * QR-коди мережевої гри: показ (qrcode-generator) і сканування камерою (BarcodeDetector, де є, інакше jsQR).
 * Камера браузерам доступна лише в захищеному контексті (HTTPS, localhost) — на dev-сервері ПК за адресою в мережі
 * її немає, тоді обмін кодами текстом.
 */
import qrcode from 'qrcode-generator';

/**
 * Полотно з QR-кодом (чорне на білому, поле 4 модулі), сторона — size пікселів (кратна модулю). Код з'єднання — у
 * алфавітно-цифровому наборі QR (5,5 біта на символ замість 8) і з найменшим запасом на помилки (L): з екрана на
 * камеру пошкоджень майже немає, а клітинки виходять більші — камера читає легше.
 */
export function qrCanvas(text: string, size: number): HTMLCanvasElement {
  const qr = qrcode(0, 'L');
  qr.addData(text, /^[0-9A-Z $%*+\-./:]*$/.test(text) ? 'Alphanumeric' : 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const total = n + 8;
  const cell = Math.max(1, Math.floor(size / total));
  const c = document.createElement('canvas');
  c.width = c.height = cell * total;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) g.fillRect((x + 4) * cell, (y + 4) * cell, cell, cell);
  return c;
}

export function cameraAvailable(): boolean {
  return !!navigator.mediaDevices?.getUserMedia;
}

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/**
 * Розпізнаємо лише квадрат посередині кадру (SCAN_CROP меншої сторони — QR-код друга наводять у центр), зменшений до
 * SCAN_SIZE пікселів: утричі-вчетверо менше роботи, ніж увесь кадр 640 px, а клітинка QR версії 5 у такому квадраті
 * все одно ≥ 4 px, поки код займає хоч половину квадрата.
 */
const SCAN_SIZE = 400;
const SCAN_CROP = 0.8;
/** Пауза між спробами, мс (батарея телефона). */
const SCAN_EVERY = 150;

/** Сканер: відео з задньої камери в елементі video, onCode — кожен розпізнаний рядок. */
export class QrScanner {
  private stream: MediaStream | null = null;
  private timer = 0;
  private stopped = false;
  private readonly frame = document.createElement('canvas');

  constructor(
    readonly video: HTMLVideoElement,
    private readonly onCode: (text: string) => void,
  ) {
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    if (this.stopped) return this.stop();
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    const detector = await makeDetector();
    const decode = detector ? null : (await import('jsqr')).default;
    const loop = async () => {
      if (this.stopped) return;
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth) {
        const side = Math.min(v.videoWidth, v.videoHeight) * SCAN_CROP;
        const w = Math.round(Math.min(SCAN_SIZE, side));
        const h = w;
        if (this.frame.width !== w) {
          this.frame.width = w;
          this.frame.height = h;
        }
        const g = this.frame.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, w, h);
        let text: string | null = null;
        if (detector) text = (await detector.detect(this.frame).catch(() => []))[0]?.rawValue ?? null;
        else if (decode) text = decode(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
        if (text && !this.stopped) this.onCode(text);
      }
      if (!this.stopped) this.timer = window.setTimeout(loop, SCAN_EVERY);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }
}

/** Вбудований розпізнавач браузера (Chrome на Android), якщо вміє QR. */
async function makeDetector(): Promise<Detector | null> {
  const BD = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
  if (!BD) return null;
  try {
    return (await BD.getSupportedFormats()).includes('qr_code') ? new BD({ formats: ['qr_code'] }) : null;
  } catch {
    return null;
  }
}

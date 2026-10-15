import type { FileSource } from '@shared/source';
import { HT2_MUSIC } from '../files';
import { MUTED } from '../engine/audio/engineAudio';

/**
 * Музика Дальнобойщиків 2 (`MUSIC/track01l…12l.mp3`, тека з TRUCK.INI [INSTALL] MUSIC): треки по черзі з випадкового,
 * поки їдемо. Гучність — [EFFECTS] midivol=20 з TRUCK.INI як частка (гіпотеза: шкала 0…100), але не тихіше 0,35 —
 * на телефоні 0,2 майже не чути. Файлів немає (не імпортовано) — тиша.
 */
export class Music {
  private readonly audio = new Audio();
  private url: string | null = null;
  private index = Math.floor(Math.random() * HT2_MUSIC.length);
  private failures = 0;
  on = true;

  constructor(
    private readonly source: FileSource,
    volume = 0.35,
  ) {
    this.audio.volume = MUTED ? 0 : volume;
    this.audio.addEventListener('ended', () => void this.next());
  }

  async next(): Promise<void> {
    if (!this.on || this.failures >= HT2_MUSIC.length) return;
    this.index = (this.index + 1) % HT2_MUSIC.length;
    try {
      const bytes = await this.source.read(HT2_MUSIC[this.index]);
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/mpeg' }));
      this.audio.src = this.url;
      this.failures = 0;
      await this.audio.play().catch(() => {
        // Без жесту користувача браузер не грає — почнемо після першого дотику.
        const go = () => void this.audio.play().catch(() => {});
        window.addEventListener('pointerup', go, { once: true });
      });
    } catch {
      this.failures++;
      void this.next();
    }
  }

  /** Гучність (меню Esc «Звук»), 0…1. */
  setVolume(v: number): void {
    this.audio.volume = MUTED ? 0 : Math.max(0, Math.min(1, v));
  }

  toggle(): boolean {
    this.on = !this.on;
    if (this.on) {
      if (this.audio.src) void this.audio.play().catch(() => {});
      else void this.next();
    } else this.audio.pause();
    return this.on;
  }

  dispose(): void {
    this.audio.pause();
    this.audio.src = '';
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

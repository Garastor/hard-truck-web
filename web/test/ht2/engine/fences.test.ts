// Огорожі блоку 20 — стіни на всю висоту кімнати, як у king.exe (тест лише на плані), — на даних регіону ar.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseB3d } from '@ht2/engine/formats/b3d';
import { levelCollision } from '@ht2/engine/physics/collision';
import { HT2_DIR } from '../../gameDirs';

const file = join(HT2_DIR, 'ENV', 'ar.b3d');

describe.skipIf(!existsSync(file))('HT2: огорожі кімнат (ar_026)', () => {
  it('межа на схилі над дорогою (−3850, −2243) — стіна й на висоті дороги', () => {
    const col = levelCollision(parseB3d(new Uint8Array(readFileSync(file))));
    // Огорожі ar_026, що проходять ближче 8 м від місця, де машина без правки виїжджала схилом за край світу.
    const near = col.walls.filter((p, i) => {
      if (!col.wallFence[i] || col.wallRoom[i].toLowerCase() !== 'room_ar_026') return false;
      const [a, b] = p;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((-3850 - a[0]) * dx + (-2243 - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(a[0] + dx * t + 3850, a[1] + dy * t + 2243) < 8;
    });
    expect(near.length).toBeGreaterThan(0);
    // Точки ламаної — на схилі біля дороги (31 м); смуга «точки −1…+3 м» сягала лише 33 м, і машина виїжджала схилом
    // понад нею за край світу. Стіна на всю висоту кімнати тримає й на дорозі, й на схилі.
    for (const p of near) {
      const zs = p.map((q) => q[2]);
      expect(Math.min(...zs)).toBeLessThan(30);
      expect(Math.max(...zs)).toBeGreaterThan(45);
    }
  });
});

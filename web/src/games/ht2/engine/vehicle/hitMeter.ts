import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

/**
 * Удари для кінематичного руху king.exe: горизонтальна зміна швидкості, якої не дав власний крок моделі, — лише
 * зіткнення (контакти Rapier під час world.step). Кінематичний поворот повертає вектор швидкості щокроку (на повному
 * кермі з Ctrl — на кілька м/с за кадр), і облік «зміни швидкості за кадр» приймав це за удар: вмʼятини й
 * пошкодження в чистому повороті. Вертикаль — як і раніше, за кадр (приземлення, вибоїни: кінематичний крок нормальну
 * складову не змінює).
 */
export class HitMeter {
  /** Швидкість, з якою тіло пішло в world.step минулого кроку. */
  private readonly sent = new THREE.Vector3();
  private armed = false;
  private readonly acc = new THREE.Vector3();
  private prevY = 0;

  constructor(
    private readonly body: RAPIER.RigidBody,
    private readonly world: RAPIER.World,
  ) {}

  /** На початку кроку моделі, до власних змін швидкості: що додав світ за минулий крок, крім ваги. */
  begin(dt: number): void {
    if (!this.armed) return;
    this.armed = false;
    const lv = this.body.linvel();
    const g = this.world.gravity;
    this.acc.x += lv.x - this.sent.x - g.x * dt;
    this.acc.z += lv.z - this.sent.z - g.z * dt;
  }

  /** Наприкінці кроку моделі (тіло йде в world.step із цією швидкістю). */
  end(): void {
    const lv = this.body.linvel();
    this.sent.set(lv.x, lv.y, lv.z);
    this.armed = true;
  }

  /** Перестановка тіла: стрибок швидкості — не удар. */
  reset(): void {
    this.armed = false;
    this.acc.set(0, 0, 0);
    this.prevY = this.body.linvel().y;
  }

  /** Зміна швидкості від ударів з минулого виклику (світ, м/с): горизонталь — зіткнення, вертикаль — за кадр. */
  take(): THREE.Vector3 {
    const y = this.body.linvel().y;
    const dv = new THREE.Vector3(this.acc.x, y - this.prevY, this.acc.z);
    this.prevY = y;
    this.acc.set(0, 0, 0);
    return dv;
  }
}

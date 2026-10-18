import * as THREE from 'three';

/**
 * Світлові плями фар машин трафіку на дорозі — власна реалізація на прохання користувача (оригінального механізму
 * не знайдено, Docs/ht2/lighting.md). Справжній прожектор на кожну машину телефон не витягне: three.js рахує кожне
 * світло в кожному пікселі світу, а зміна кількості світел перекомпільовує шейдери. Тому пляма — плаский полігон у
 * площині машини перед нею, що множить колір під собою: результат = під · (1 + яскравість), тобто дорога світлішає
 * пропорційно своєму кольору, як від світла (а не сіріє, як від додавання). Ціна — лише пікселі самої плями.
 *
 * Плям дві — від кожної фари, посередині перекриваються. Колір плями — не сірий: під плямою колір = альбедо · нічне
 * світло (синювате розсіяне + місяць), а фара додає альбедо · тепле світло, тож множник = 1 + світло фари / нічне
 * світло окремо для кожного каналу (setPoolLight) — інакше пляма підсилювала синяву й світилася, як неон, і
 * відрізнялася від прожекторів (drive.ts carLamps), що змінюють її на найближчій зустрічній.
 *
 * Обмеження: світить лише в площині машини (стіни й інші машини не освітлює); на перегині дороги дальній край
 * ховається під асфальт чи трохи висить — тому пляма коротка (POOL_LENGTH).
 */
const POOL_LENGTH = 26;
const POOL_WIDTH = 7;
/** Додаток кольору плями однієї фари (множник 1 + tint · маска; 0…1 — вихід кадру не більший за 1). */
const tint = new THREE.Color(0.5, 0.5, 0.5);

/**
 * Частка поканальної поправки кольору (0 — рівне підсилення за яскравістю, 1 — точно «фара / нічне світло» по
 * каналах): чиста поправка давала помаранчеву пляму (у місячному світлі майже немає червоного), рівне підсилення —
 * синю «неонову»; 0,2 — на око.
 */
const TINT_HUE = 0.2;

/**
 * Світло плями: lamp — колір фари, power — освітленість від неї (у тих самих одиницях, що й розсіяне світу:
 * Lambert ділить силу прямого світла на π), base — нічне світло дороги під плямою (розсіяне + місяць).
 */
export function setPoolLight(lamp: THREE.Color, power: number, base: THREE.Color): void {
  const lum = Math.max(0.02, 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b);
  const ch = (l: number, b: number) => Math.min(1, (1 - TINT_HUE) * ((power * l) / lum) + TINT_HUE * ((power * l) / Math.max(b, 0.02)));
  tint.setRGB(ch(lamp.r, base.r), ch(lamp.g, base.g), ch(lamp.b, base.b));
}
/** Підйом над дорогою, м — щоб не мерехтіла з асфальтом (плюс зсув глибини). */
const POOL_LIFT = 0.08;

let poolTexture: THREE.Texture | null = null;

/**
 * Форма плями згори: u — поперек, v — уздовж (0 — біля машини, 1 — дальній край). Розширюється вперед від ширини
 * машини до POOL_WIDTH, рівна вздовж, мʼякі краї: біля бампера, з боків і плавне згасання на дальній чверті.
 */
function texture(): THREE.Texture {
  if (poolTexture) return poolTexture;
  const W = 64;
  const H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const smooth = (e: number) => {
    const x = Math.min(1, Math.max(0, e));
    return x * x * (3 - 2 * x);
  };
  for (let j = 0; j < H; j++) {
    // Верхній рядок полотна — дальній край (v = 1).
    const v = 1 - (j + 0.5) / H;
    const half = 0.18 + 0.32 * Math.min(1, v / 0.6);
    const along = smooth(v / 0.08) * smooth((1 - v) / 0.3);
    for (let i = 0; i < W; i++) {
      const u = Math.abs((i + 0.5) / W - 0.5);
      const a = along * smooth((half - u) / (0.35 * half));
      const k = (j * W + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.round(255 * a);
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  poolTexture = new THREE.CanvasTexture(canvas);
  return poolTexture;
}

/**
 * Плями двох фар (свій матеріал на машину — для згасання з відстанню): вісь машини −Z, дорога — y = ground,
 * бампер — z = front, фари — x = left і right.
 */
export function makePool(ground: number, front: number, left: number, right: number): THREE.Group {
  const mat = new THREE.MeshBasicMaterial({
    map: texture(),
    color: tint.clone(),
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.OneFactor,
    transparent: true,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const geo = new THREE.PlaneGeometry(POOL_WIDTH, POOL_LENGTH);
  const g = new THREE.Group();
  g.name = 'HeadPools';
  for (const x of [left, right]) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, ground + POOL_LIFT, front - POOL_LENGTH / 2);
    mesh.renderOrder = 1;
    g.add(mesh);
  }
  return g;
}

/** Згасання плям з відстанню до гравця (fade 0…1: 1 — повна, 0 — сховані). */
export function setPoolFade(pool: THREE.Group, fade: number): void {
  pool.visible = fade > 0.01;
  ((pool.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(tint).multiplyScalar(fade);
}

export function disposePool(pool: THREE.Group): void {
  pool.removeFromParent();
  const m = pool.children[0] as THREE.Mesh | undefined;
  m?.geometry.dispose();
  (m?.material as THREE.Material | undefined)?.dispose();
}

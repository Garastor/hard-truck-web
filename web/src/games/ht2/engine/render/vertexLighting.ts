import * as THREE from 'three';

/**
 * Світло в вершинах (Гуро), як Direct3D7 у king.exe: сонце, місяць (напрямлені) і точкові світла (спалах вибуху)
 * рахуються для кожної вершини й інтерполюються по полігону; текстура множиться в пікселі. three.js (Lambert, Phong)
 * рахує це в кожному пікселі — на телефоні вдвічі-втричі дорожче, а відблиск на кузовах різкіший, ніж в оригіналі
 * (docs/ht2/lighting.md §7). Прожектори (фари гравця й зустрічної з маскою ближнього світла) лишаються попіксельними:
 * у вершинах великих полігонів дороги пляма фари розмазалася б. Розсіяне світло однакове в усіх точках — без змін.
 *
 * Шматки шейдерів спільні для всіх матеріалів (як vertexFog і фари): у вершинному шейдері Lambert/Phong — сума
 * освітленості dotNL·колір (і для зворотного боку двобічних), у Phong ще дзеркальна складова Blinn-Phong, розкладена
 * на частини «× колір відблиску» і «Френель» (колір відблиску — властивість матеріалу, множиться в пікселі). Пласке
 * затінення (FLAT_SHADED) — без змін. Першу гру не зачіпає: вихід до вибору гри перезавантажує сторінку.
 */
export function installVertexLighting(): void {
  const c = THREE.ShaderChunk as unknown as Record<string, string>;
  // Кожен шматок дописується лише раз (installVertexFog при повторному виклику переписує fog_* заново).
  const once = (name: string, edit: (s: string) => string) => {
    if (!c[name].includes('HT2_VERTEX_LIGHT')) c[name] = edit(c[name]);
  };

  // Вершинний шейдер: оголошення (fog_pars_vertex є в усіх освітлюваних матеріалах) і підрахунок (fog_vertex — після
  // project_vertex: є mvPosition і transformedNormal).
  once('fog_pars_vertex', (s) => s + VERTEX_PARS);
  once('fog_vertex', (s) => s + VERTEX_MAIN);
  once('lights_lambert_pars_fragment', (s) => FRAGMENT_PARS + s);
  once('lights_phong_pars_fragment', (s) => FRAGMENT_PARS + s);
  once('lights_fragment_begin', fragmentLights);
}

const VERTEX_PARS = `
#if ( defined( LAMBERT ) || defined( PHONG ) ) && ! defined( FLAT_SHADED )
	#define HT2_VERTEX_LIGHT
	#include <lights_pars_begin>
	varying vec3 vHt2Diffuse;
	#ifdef DOUBLE_SIDED
		varying vec3 vHt2DiffuseBack;
	#endif
	#ifdef PHONG
		uniform float shininess;
		varying vec3 vHt2SpecA;
		varying vec3 vHt2SpecB;
	#endif
	void ht2AddLight( const in IncidentLight l, const in vec3 n, const in vec3 v ) {
		float dotNL = saturate( dot( n, l.direction ) );
		vHt2Diffuse += dotNL * l.color;
		#ifdef DOUBLE_SIDED
			vHt2DiffuseBack += saturate( - dot( n, l.direction ) ) * l.color;
		#endif
		#ifdef PHONG
			// BRDF_BlinnPhong three.js: F_Schlick(specular, 1, v·h) · 0,25 · D_BlinnPhong(shininess, n·h).
			vec3 h = normalize( l.direction + v );
			float dotNH = saturate( dot( n, h ) );
			float dotVH = saturate( dot( v, h ) );
			float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
			float gd = 0.25 * RECIPROCAL_PI * ( shininess * 0.5 + 1.0 ) * pow( dotNH, shininess );
			vec3 irradiance = dotNL * l.color;
			vHt2SpecA += irradiance * ( 1.0 - fresnel ) * gd;
			vHt2SpecB += irradiance * fresnel * gd;
		#endif
	}
#endif
`;

const VERTEX_MAIN = `
#ifdef HT2_VERTEX_LIGHT
	{
		vec3 ht2N = normalize( transformedNormal );
		vec3 ht2V = isOrthographic ? vec3( 0.0, 0.0, 1.0 ) : normalize( - mvPosition.xyz );
		vHt2Diffuse = vec3( 0.0 );
		#ifdef DOUBLE_SIDED
			vHt2DiffuseBack = vec3( 0.0 );
		#endif
		#ifdef PHONG
			vHt2SpecA = vec3( 0.0 );
			vHt2SpecB = vec3( 0.0 );
		#endif
		IncidentLight ht2L;
		#if NUM_DIR_LIGHTS > 0
			#pragma unroll_loop_start
			for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
				getDirectionalLightInfo( directionalLights[ i ], ht2L );
				ht2AddLight( ht2L, ht2N, ht2V );
			}
			#pragma unroll_loop_end
		#endif
		#if NUM_POINT_LIGHTS > 0
			#pragma unroll_loop_start
			for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
				getPointLightInfo( pointLights[ i ], mvPosition.xyz, ht2L );
				ht2AddLight( ht2L, ht2N, ht2V );
			}
			#pragma unroll_loop_end
		#endif
	}
#endif
`;

/** Фрагментний: ті самі varying, напрямлені й точкові світла — з вершин замість циклів у пікселі. */
const FRAGMENT_PARS = `
#ifndef FLAT_SHADED
	#define HT2_VERTEX_LIGHT
	varying vec3 vHt2Diffuse;
	#ifdef DOUBLE_SIDED
		varying vec3 vHt2DiffuseBack;
	#endif
	#ifdef PHONG
		varying vec3 vHt2SpecA;
		varying vec3 vHt2SpecB;
	#endif
#endif
`;

function fragmentLights(src: string): string {
  let f = src;
  for (const kind of ['POINT', 'DIR']) {
    const from = `#if ( NUM_${kind}_LIGHTS > 0 ) && defined( RE_Direct )`;
    if (!f.includes(from)) throw new Error(`vertexLighting: шматок шейдера світла ${kind} змінився`);
    f = f.replace(from, `${from} && ! defined( HT2_VERTEX_LIGHT )`);
  }
  const indirect = '#if defined( RE_IndirectDiffuse )';
  if (!f.includes(indirect)) throw new Error('vertexLighting: шматок шейдера розсіяного світла змінився');
  f = f.replace(
    indirect,
    `#ifdef HT2_VERTEX_LIGHT
	{
		vec3 ht2Irradiance = vHt2Diffuse;
		#ifdef DOUBLE_SIDED
			ht2Irradiance = gl_FrontFacing ? vHt2Diffuse : vHt2DiffuseBack;
		#endif
		reflectedLight.directDiffuse += ht2Irradiance * BRDF_Lambert( material.diffuseColor );
		#ifdef PHONG
			#ifdef DOUBLE_SIDED
				if ( gl_FrontFacing )
			#endif
			reflectedLight.directSpecular += ( material.specularColor * vHt2SpecA + vHt2SpecB ) * material.specularStrength;
		#endif
	}
#endif

${indirect}`,
  );
  return f;
}

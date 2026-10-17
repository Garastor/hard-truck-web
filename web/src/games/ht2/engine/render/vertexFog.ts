import * as THREE from 'three';

/**
 * Туман як у king.exe: Direct3D7 повершинний лінійний (0x005adc80: FOGENABLE, FOGVERTEXMODE = 3 LINEAR, FOGSTART /
 * FOGEND). Множник (z − start) / (end − start) рахується у вершинах за глибиною в просторі камери, обрізається до
 * [0, 1] і лише потім інтерполюється по полігону. three.js натомість бере smoothstep у кожному пікселі: на початку
 * відрізка туману вдвічі-втричі слабше (на 30 % — 0,22 замість 0,30), а довгий полігон (смуги лісу на обрії, далека
 * трава), що зачіпає туман лише дальнім краєм, лишався зовсім без серпанку — ліс виходив удвічі темнішим і не
 * синюватим, як в оригіналі. Шматки шейдерів спільні для всіх матеріалів; вихід до вибору гри перезавантажує
 * сторінку, тож першу гру це не зачіпає. vFogDepth лишається (власний туман неба в sceneBuilder).
 */
export function installVertexFog(): void {
  const c = THREE.ShaderChunk as unknown as Record<string, string>;
  c.fog_pars_vertex = `#ifdef USE_FOG
	varying float vFogDepth;
	varying float vFogFactor;
	#ifndef FOG_EXP2
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`;
  c.fog_vertex = `#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	#ifdef FOG_EXP2
		vFogFactor = 0.0;
	#else
		vFogFactor = clamp( ( vFogDepth - fogNear ) / max( fogFar - fogNear, 1e-4 ), 0.0, 1.0 );
	#endif
#endif`;
  c.fog_pars_fragment = `#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying float vFogFactor;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`;
  c.fog_fragment = `#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = vFogFactor;
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;
}

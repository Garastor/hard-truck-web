"""
Збирання декодера Indeo 5 для WebAssembly (ролики HT2 *.bne) — tools/video/README.md.

Без make: configure FFmpeg (bash з Git for Windows) з одним декодером indeo5, далі цей скрипт читає OBJS з
Makefile бібліотек за ffbuild/config.mak, компілює emcc і лінкує з indeo5.c у ES-модуль
web/src/games/ht2/engine/video/indeo5.js + indeo5.wasm.

    .venv/Scripts/python -I tools/video/build.py --ffmpeg D:/ht2-build/ffmpeg --emsdk D:/emsdk --out D:/ht2-build/out
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DEST = os.path.join(ROOT, 'web', 'src', 'games', 'ht2', 'engine', 'video')

CONFIGURE = [
    '--target-os=none', '--arch=x86_32', '--enable-cross-compile', '--disable-asm', '--disable-inline-asm',
    '--disable-x86asm', '--disable-stripping', '--disable-programs', '--disable-doc', '--disable-debug',
    '--disable-everything', '--disable-avdevice', '--disable-avformat', '--disable-swresample', '--disable-swscale',
    '--disable-avfilter', '--disable-network', '--disable-pthreads', '--disable-w32threads', '--disable-os2threads',
    '--disable-runtime-cpudetect', '--disable-autodetect', '--enable-decoder=indeo5', '--disable-iconv',
    '--cc=emcc', '--host-cc=emcc', '--cxx=em++', '--ar=emar', '--ranlib=emranlib', '--nm=emnm -g',
    '--extra-cflags=-O3', '--pkg-config=false',
]


def env_with(emsdk):
    env = dict(os.environ)
    ups = os.path.join(emsdk, 'upstream', 'emscripten')
    env['PATH'] = os.pathsep.join([ups, os.path.join(emsdk, 'upstream', 'bin'), env['PATH']])
    env['EMSDK'] = emsdk
    return env, ups


def config_vars(out):
    v = {}
    for line in open(os.path.join(out, 'ffbuild', 'config.mak'), encoding='utf-8'):
        m = re.match(r'^(!?)([A-Za-z0-9_]+)=(.*)$', line.strip())
        if m:
            v[m.group(2)] = '' if m.group(1) else m.group(3)
    return v


def makefile_objs(src, path, v, prefix):
    """OBJS і OBJS-$(VAR) бібліотеки (з include підтек), лише ввімкнені."""
    text = open(path, encoding='utf-8').read().replace('\\\n', ' ')
    objs = []
    for line in text.split('\n'):
        inc = re.match(r'^-?include \$\(SRC_PATH\)/(\S+)$', line)
        if inc and '$(' not in inc.group(1):
            objs += makefile_objs(src, os.path.join(src, inc.group(1)), v, prefix)
            continue
        m = re.match(r'^OBJS(?:-\$\((\w+)\))?\s*\+?=\s*(.*)$', line)
        if not m:
            continue
        if m.group(1) and v.get(m.group(1)) != 'yes':
            continue
        objs += [o for o in m.group(2).split() if o.endswith('.o')]
    return objs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ffmpeg', required=True)
    ap.add_argument('--emsdk', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--bash', default=r'C:\Program Files\Git\bin\bash.exe')
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    src = os.path.abspath(a.ffmpeg).replace('\\', '/')
    out = os.path.abspath(a.out)
    env, ups = env_with(a.emsdk)
    os.makedirs(out, exist_ok=True)
    if not os.path.exists(os.path.join(out, 'ffbuild', 'config.mak')):
        cmd = f'"{src}/configure" ' + ' '.join(f"'{c}'" for c in CONFIGURE)
        subprocess.run([a.bash, '-lc', f'cd "{out.replace(chr(92), "/")}" && {cmd}'], check=True, env=env)
    # Заголовок версії make генерує ffbuild/version.sh — тут без make.
    ver = os.path.join(out, 'libavutil', 'ffversion.h')
    if not os.path.exists(ver):
        tag = open(os.path.join(src, 'RELEASE'), encoding='utf-8').read().strip()
        lines = ['#ifndef AVUTIL_FFVERSION_H', '#define AVUTIL_FFVERSION_H', f'#define FFMPEG_VERSION "{tag}"', '#endif', '']
        open(ver, 'w').write('\n'.join(lines))
    v = config_vars(out)
    units = []
    for lib in ('libavutil', 'libavcodec'):
        for o in makefile_objs(src, os.path.join(src, lib, 'Makefile'), v, lib):
            units.append(os.path.join(lib, o[:-2]))
    units = sorted(set(units))
    emcc = next(p for p in (os.path.join(ups, n) for n in ('emcc.exe', 'emcc.bat', 'emcc')) if os.path.exists(p))
    cflags = ['-O3', '-std=gnu17', '-DHAVE_AV_CONFIG_H', '-D_ISOC11_SOURCE', '-I' + out, '-I' + src,
              '-Wno-everything']
    objdir = os.path.join(out, 'obj')

    def compile_unit(u):
        c = os.path.join(out, u + '.c')
        if not os.path.exists(c):
            c = os.path.join(src, u + '.c')
        if not os.path.exists(c):
            return None
        o = os.path.join(objdir, u + '.o')
        os.makedirs(os.path.dirname(o), exist_ok=True)
        if not os.path.exists(o) or os.path.getmtime(o) < os.path.getmtime(c):
            r = subprocess.run([emcc, *cflags, '-c', c, '-o', o], env=env, capture_output=True, text=True)
            if r.returncode:
                sys.exit(f'{u}: {r.stderr}')
        return o

    with ThreadPoolExecutor(8) as ex:
        objs = [o for o in ex.map(compile_unit, units) if o]
    print(f'{len(objs)} обʼєктів')
    os.makedirs(DEST, exist_ok=True)
    js = os.path.join(DEST, 'indeo5.js')
    link = [
        emcc, '-O3', *cflags[2:], os.path.join(HERE, 'indeo5.c'), *objs, '-o', js,
        '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,worker,node', '-sALLOW_MEMORY_GROWTH=1',
        '-sFILESYSTEM=0', '-sEXPORTED_RUNTIME_METHODS=HEAPU8', '-sEXPORT_NAME=createIndeo5',
        '-sEXPORTED_FUNCTIONS=_iv_open,_iv_input,_iv_decode,_iv_rgba,_iv_close,_malloc,_free',
    ]
    subprocess.run(link, check=True, env=env)
    shutil.copy(os.path.join(src, 'COPYING.LGPLv2.1'), os.path.join(DEST, 'LICENSE.LGPL-2.1.txt'))
    for f in ('indeo5.js', 'indeo5.wasm'):
        print(f, os.path.getsize(os.path.join(DEST, f)))


if __name__ == '__main__':
    main()

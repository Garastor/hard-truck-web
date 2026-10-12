"""Іконки «Дальнобойщиків 2» для теки-входу /ht2/ (окрема іконка на головному екрані телефона).

Беремо іконку порту (помаранчеве коло з вантажівкою), перефарбовуємо коло у фіолетово-синій колір меню HT2
(зберігаючи згладжені краї: колір пікселя розкладається між фоном і помаранчевим) і пишемо римське «II» (із засічками, як у лого HT2) над вантажівкою.

    .venv/Scripts/python -I tools/ui/make_ht2_icon.py web/public
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ORANGE = (224, 164, 48)
VIOLET = (112, 96, 214)


def recolor(im: Image.Image) -> Image.Image:
    px = im.load()
    w, h = im.size
    bg = px[1, 1][:3]
    d = [o - b for o, b in zip(ORANGE, bg)]
    dd = sum(x * x for x in d)
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            c = (r - bg[0], g - bg[1], b - bg[2])
            t = max(0.0, min(1.0, sum(ci * di for ci, di in zip(c, d)) / dd))
            near = [bg[i] + d[i] * t for i in range(3)]
            if sum((v - n) ** 2 for v, n in zip((r, g, b), near)) < 900 and t > 0.02:
                px[x, y] = tuple(round(bg[i] + (VIOLET[i] - bg[i]) * t) for i in range(3)) + (a,)
    return im


def main(out_dir: str) -> None:
    out = Path(out_dir)
    for size in (192, 512):
        im = Image.open(out / f'icon-{size}.png').convert('RGBA')
        im = recolor(im)
        draw = ImageDraw.Draw(im)
        font = ImageFont.truetype('C:/Windows/Fonts/timesbd.ttf', round(size * 0.24))
        text = 'II'
        box = draw.textbbox((0, 0), text, font=font)
        tw, th = box[2] - box[0], box[3] - box[1]
        draw.text(((size - tw) / 2 - box[0], size * 0.155 - box[1]), text, font=font, fill=(244, 236, 210, 255))
        im.save(out / f'icon2-{size}.png', optimize=True)


if __name__ == '__main__':
    main(sys.argv[1])

"""Значок «телефон» для згорнутої групи кнопок кар'єри: квадратна версія знака зі зразка користувача.

Зразок (вертикальний знак 733×952 у файлі 754×980) розрізаємо: верхній край, біле поле з трубкою, нижній край;
синє поле добудовуємо смугами так, щоб відступи до білого поля були однакові з усіх боків (квадрат 733×733).
Фон поза знаком — прозорий; зменшення — Lanczos.

    .venv/Scripts/python -I tools/ui/make_call_sign.py <зразок.png> web/src/assets/call-sign.png
"""
import sys

from PIL import Image, ImageDraw

SIGN = (11, 14, 744, 966)  # x0, y0, x1, y1 знака у зразку
SQUARE_Y = (103, 584)  # біле поле по вертикалі
SIZE = 132  # 44 CSS-пікселі × 3 (щільність iPhone)


def main(src: str, dst: str) -> None:
    im = Image.open(src).convert('RGB')
    x0, y0, x1, y1 = SIGN
    sign = im.crop(SIGN)
    w, h = sign.size
    margin = SQUARE_Y[0] - y0  # відступ згори у зразку (до білого поля)
    side = 137 - x0  # відступ збоку — такий хочемо й згори/знизу
    sq0, sq1 = SQUARE_Y[0] - y0, SQUARE_Y[1] - y0
    out = Image.new('RGB', (w, w))
    top = sign.crop((0, 0, w, margin))
    out.paste(top, (0, 0))
    band = sign.crop((0, margin - 8, w, margin - 7))  # рядок синього поля між білою лінією й білим полем
    for y in range(margin, side):
        out.paste(band, (0, y))
    out.paste(sign.crop((0, sq0, w, sq1)), (0, side))
    bottom = sign.crop((0, h - margin, w, h))
    out.paste(bottom, (0, w - margin))
    band2 = sign.crop((0, h - margin, w, h - margin + 1))
    for y in range(side + (sq1 - sq0), w - margin):
        out.paste(band2, (0, y))
    # Білий фон поза заокругленими кутами — прозорий.
    rgba = out.convert('RGBA')
    for c in [(0, 0), (w - 1, 0), (0, w - 1), (w - 1, w - 1)]:
        ImageDraw.floodfill(rgba, c, (255, 255, 255, 0), thresh=60)
    rgba.resize((SIZE, SIZE), Image.LANCZOS).save(dst, optimize=True)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])

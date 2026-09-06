#!/usr/bin/env python3
"""Draw build/icon-source.png — the app icon artwork.

A purple rounded square, a white page floating on it, and the wordmark in Estedad.
Run scripts/make-icons.py afterwards to cut the alpha and produce .ico / .icns.

    python3 scripts/make-icon-source.py [text]
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "icon-source.png"
FONT = ROOT / "assets" / "fonts" / "Estedad-VF.ttf"

SIZE = 1024
SS = 2                                   # supersample factor
BG_TOP = (92, 102, 216)
BG_BOTTOM = (104, 94, 209)
BG_RADIUS = 200
CARD = (173, 149, 851, 875)              # left, top, right, bottom
CARD_RADIUS = 56
CARD_FILL = (253, 253, 252)
INK = (83, 99, 209)
TEXT_WIDTH_RATIO = 0.60                  # of the card width
FONT_WEIGHT = 800


def load_font(px: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(str(FONT), px)
    try:
        font.set_variation_by_axes([FONT_WEIGHT])
    except Exception:
        pass                             # static build of the font — fine
    return font


def draw(text: str) -> Image.Image:
    s = SIZE * SS
    img = Image.new("RGB", (s, s), (255, 255, 255))

    # vertical gradient, clipped to the rounded square
    gradient = Image.new("RGB", (1, s))
    for y in range(s):
        t = y / (s - 1)
        gradient.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))
    gradient = gradient.resize((s, s))
    shape = Image.new("L", (s, s), 0)
    ImageDraw.Draw(shape).rounded_rectangle([0, 0, s - 1, s - 1], radius=BG_RADIUS * SS, fill=255)
    img.paste(gradient, (0, 0), shape)

    card = [c * SS for c in CARD]

    # soft drop shadow under the card
    shadow = Image.new("L", (s, s), 0)
    ImageDraw.Draw(shadow).rounded_rectangle(
        [card[0], card[1] + 16 * SS, card[2], card[3] + 16 * SS],
        radius=CARD_RADIUS * SS, fill=90,
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(20 * SS))
    img.paste(Image.new("RGB", (s, s), (40, 42, 90)), (0, 0), shadow)

    ImageDraw.Draw(img).rounded_rectangle(card, radius=CARD_RADIUS * SS, fill=CARD_FILL)

    # wordmark, scaled to the card and optically centred
    target = (card[2] - card[0]) * TEXT_WIDTH_RATIO
    px = 100 * SS
    font = load_font(px)
    box = font.getbbox(text)
    px = round(px * target / (box[2] - box[0]))
    font = load_font(px)
    box = font.getbbox(text)
    cx = (card[0] + card[2]) / 2
    cy = (card[1] + card[3]) / 2
    ImageDraw.Draw(img).text(
        (cx - (box[0] + box[2]) / 2, cy - (box[1] + box[3]) / 2), text, font=font, fill=INK
    )

    return img.resize((SIZE, SIZE), Image.LANCZOS)


if __name__ == "__main__":
    text = sys.argv[1] if len(sys.argv) > 1 else "MD"
    draw(text).save(OUT)
    print(f"wrote {OUT.relative_to(ROOT)} — “{text}”")

#!/usr/bin/env python3
"""Regenerate the app icons from build/icon-source.png.

Two things here are not what a naive `Image.save('icon.ico')` gives you:

1.  Transparent corners. The source art is a rounded square drawn on white; saved
    as-is, Windows and macOS paint white triangles in the corners on dark themes.
    We cut a real alpha channel with the same rounded-rect geometry.

2.  BMP-encoded .ico frames. Pillow writes every frame PNG-compressed, which is
    only officially supported for 256x256. NSIS (the Windows installer) and the
    Explorer shortcut code path can reject the small PNG frames — that is what
    made the 1.0.0 installer complain about the icon file and drop a blank,
    broken shortcut on the desktop. Every frame here is an uncompressed BMP with
    wPlanes=1, which every Windows version has understood since Windows 95.

    python3 scripts/make-icons.py
"""

import struct
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
SOURCE = BUILD / "icon-source.png"
RADIUS_RATIO = 200 / 1024          # measured from the original artwork
MAC_INSET_RATIO = 0.10             # macOS icons sit in a ~82% content box
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def rounded_mask(size: int, radius: float, supersample: int = 4) -> Image.Image:
    """Antialiased rounded-rect alpha mask."""
    big = size * supersample
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=radius * supersample, fill=255
    )
    return mask.resize((size, size), Image.LANCZOS)


def load_art() -> Image.Image:
    """Source art with rounded transparent corners.

    The white outside the rounded rect is repainted with the edge colour first:
    resizing RGBA does not premultiply alpha, so leaving it white would bleed a
    white halo into every downscaled frame.
    """
    art = Image.open(SOURCE).convert("RGB")
    size = art.size[0]
    mask = rounded_mask(size, size * RADIUS_RATIO)
    edge = art.getpixel((size // 100, size // 2))          # solid colour just inside the edge
    # erode a few pixels so the source's own white antialiasing ring goes too
    keep = mask.point(lambda v: 255 if v == 255 else 0).filter(ImageFilter.MinFilter(9))
    art = Image.composite(art, Image.new("RGB", art.size, edge), keep)
    art = art.convert("RGBA")
    art.putalpha(mask)
    return art


def write_ico(art: Image.Image, path: Path) -> None:
    """ICO with uncompressed 32-bit BMP frames — the maximally compatible shape."""
    entries, blobs, offset = [], [], 6 + 16 * len(ICO_SIZES)

    for size in ICO_SIZES:
        frame = art.resize((size, size), Image.LANCZOS)
        pixels = frame.load()

        xor = bytearray()
        for y in range(size - 1, -1, -1):              # BMP rows are bottom-up
            for x in range(size):
                r, g, b, a = pixels[x, y]
                xor += bytes((b, g, r, a))             # BGRA

        row_bytes = ((size + 31) // 32) * 4            # 1bpp, padded to 4 bytes
        and_mask = bytearray()
        for y in range(size - 1, -1, -1):
            row = bytearray(row_bytes)
            for x in range(size):
                if pixels[x, y][3] < 128:
                    row[x // 8] |= 0x80 >> (x % 8)
            and_mask += row

        header = struct.pack(
            "<IiiHHIIiiII",
            40,                 # biSize
            size,               # biWidth
            size * 2,           # biHeight — image + mask
            1,                  # biPlanes
            32,                 # biBitCount
            0,                  # biCompression = BI_RGB
            len(xor) + len(and_mask),
            0, 0, 0, 0,
        )
        blob = header + bytes(xor) + bytes(and_mask)
        entries.append(
            struct.pack(
                "<BBBBHHII",
                size % 256,     # 256 is stored as 0
                size % 256,
                0, 0,
                1,              # wPlanes
                32,             # wBitCount
                len(blob),
                offset,
            )
        )
        blobs.append(blob)
        offset += len(blob)

    path.write_bytes(
        struct.pack("<HHH", 0, 1, len(ICO_SIZES)) + b"".join(entries) + b"".join(blobs)
    )


def mac_frame(art: Image.Image, size: int) -> Image.Image:
    """One .icns frame: the art scaled into the macOS content box, on transparency.

    The art is scaled first and pasted at final size — scaling the padded canvas
    instead would blend the transparent border into the edges as a dark halo.
    """
    inset = round(size * MAC_INSET_RATIO)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(art.resize((size - inset * 2, size - inset * 2), Image.LANCZOS), (inset, inset))
    return canvas


def write_icns(art: Image.Image, path: Path) -> None:
    """macOS .icns via iconutil, with the standard macOS padding around the art."""
    iconset = BUILD / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for old in iconset.glob("*.png"):
        old.unlink()
    for size in (16, 32, 128, 256, 512):
        mac_frame(art, size).save(iconset / f"icon_{size}x{size}.png")
        mac_frame(art, size * 2).save(iconset / f"icon_{size}x{size}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(path)], check=True)


def main() -> int:
    if not SOURCE.exists():
        print(f"missing {SOURCE}", file=sys.stderr)
        return 1

    art = load_art()
    art.save(BUILD / "icon.png")                        # Windows/Linux source, full bleed
    write_ico(art, BUILD / "icon.ico")
    if sys.platform == "darwin":
        write_icns(art, BUILD / "icon.icns")
    else:
        print("skipping .icns — iconutil is macOS only")

    for name in ("icon.png", "icon.ico", "icon.icns"):
        f = BUILD / name
        if f.exists():
            print(f"  {name:<12} {f.stat().st_size / 1024:7.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Report how the icons inside a Windows .exe are encoded.

The 1.0.0 installer failed because the .ico frames were PNG-compressed, which is
only valid at 256x256. This walks the PE resource tree of a built exe so the fix
can be verified on the actual shipped binary rather than on the source .ico.

    python3 scripts/check-exe-icon.py path/to/MashDavood.exe

Exits non-zero if any frame below 256x256 is PNG-compressed.
"""

import struct
import sys
from pathlib import Path

RT_ICON = 3


def sections(data: bytes, pe: int):
    n_sections = struct.unpack_from("<H", data, pe + 6)[0]
    opt_size = struct.unpack_from("<H", data, pe + 20)[0]
    table = pe + 24 + opt_size
    for i in range(n_sections):
        off = table + i * 40
        virtual_addr, raw_size, raw_ptr = struct.unpack_from("<III", data, off + 12)
        yield virtual_addr, raw_size, raw_ptr


def rva_to_offset(data: bytes, pe: int, rva: int) -> int:
    for virtual_addr, raw_size, raw_ptr in sections(data, pe):
        if virtual_addr <= rva < virtual_addr + max(raw_size, 1):
            return raw_ptr + (rva - virtual_addr)
    raise ValueError(f"RVA {rva:#x} is outside every section")


def walk(data: bytes, base: int, offset: int, depth: int = 0):
    """Yield (rva, size) for every RT_ICON data entry."""
    n_named, n_id = struct.unpack_from("<HH", data, offset + 12)
    for i in range(n_named + n_id):
        entry = offset + 16 + i * 8
        name, child = struct.unpack_from("<II", data, entry)
        if depth == 0 and (name & 0x80000000 or name != RT_ICON):
            continue   # string-named or non-icon resource type
        if child & 0x80000000:
            yield from walk(data, base, base + (child & 0x7FFFFFFF), depth + 1)
        else:
            rva, size = struct.unpack_from("<II", data, base + child)[:2]
            yield rva, size


def main(path: Path) -> int:
    data = path.read_bytes()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        print("not a PE file", file=sys.stderr)
        return 2

    magic = struct.unpack_from("<H", data, pe + 24)[0]
    dd = pe + 24 + (112 if magic == 0x20B else 96)          # PE32+ vs PE32
    res_rva = struct.unpack_from("<I", data, dd + 2 * 8)[0]
    if not res_rva:
        print("no resource directory", file=sys.stderr)
        return 2
    base = rva_to_offset(data, pe, res_rva)

    bad = 0
    frames = list(walk(data, base, base))
    for rva, size in frames:
        off = rva_to_offset(data, pe, rva)
        blob = data[off:off + 24]
        if blob[:8] == b"\x89PNG\r\n\x1a\n":
            width = struct.unpack_from(">I", blob, 16)[0]
            kind, dims = "PNG", f"{width}x{width}"
            if width < 256:
                bad += 1
        else:
            w, h = struct.unpack_from("<ii", blob, 4)
            planes, bpp = struct.unpack_from("<HH", blob, 12)
            kind, dims = "BMP", f"{w}x{h // 2} planes={planes} bpp={bpp}"
        print(f"  {kind}  {dims}  ({size} bytes)")

    print(f"\n{len(frames)} icon frame(s) in {path.name}")
    if bad:
        print(f"FAIL: {bad} frame(s) below 256x256 are PNG-compressed", file=sys.stderr)
        return 1
    print("OK: no sub-256 PNG frames")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(Path(sys.argv[1])))

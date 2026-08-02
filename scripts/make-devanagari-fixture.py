#!/usr/bin/env python3
"""
Builds a well-formed Devanagari PDF fixture: HarfBuzz-shaped glyphs (so
conjuncts and matras render correctly) plus an exact ToUnicode CMap (so
text extraction returns the original Unicode).

Why this exists: neither Chromium's printToPDF nor LibreOffice produces
correct ToUnicode reverse mappings for Devanagari — shaped ligature glyphs
come back as NUL or in visual rather than logical order. Test fixtures for
the text pipeline have to be built deliberately.

Each distinct (glyph id, source text) pair gets its own CID, so a glyph
reused for different text can never collide in the ToUnicode map. CIDs map
to real glyphs through a CIDToGIDMap stream.

Requires: python3-gi with HarfBuzz typelib, fontTools.
Usage: make-devanagari-fixture.py <font.ttf> <out.pdf>
"""

import sys
import zlib

import gi
gi.require_version("HarfBuzz", "0.0")
from gi.repository import HarfBuzz as hb  # noqa: E402
from fontTools.ttLib import TTFont  # noqa: E402

PAGE_W, PAGE_H = 595, 842          # A4 in points
MARGIN = 56
FONT_SIZE = 15
LINE_HEIGHT = 30

# (text, font size, script). "latin" lines use the base-14 Helvetica so the
# fixture exercises a mixed-script document without a second embedded font.
LINES = [
    ("देवनागरी परीक्षण", 19, "deva"),
    ("", 0, None),
    ("काठमाडौँ नेपालको राजधानी हो ।", 15, "deva"),
    ("हिन्दी और संस्कृत देवनागरी लिपि में लिखी जाती हैं ।", 15, "deva"),
    ("प्रज्ञा और क्षेत्र जैसे संयुक्ताक्षर सही रहने चाहिए ।", 15, "deva"),
    ("नेपाल एक सुन्दर देश है ॥", 15, "deva"),
    ("देवनागरी अंक: ०१२३४५६७८९ ।", 15, "deva"),
    ("क़िला और क़लम में नुक़्ता है ।", 15, "deva"),
    ("यह वाक्य काठमाडौँ शब्द को दोहराता है: काठमाडौँ ।", 15, "deva"),
    ("", 0, None),
    ("A cafe in Paris, studied by NASA. Serendipity.", 14, "latin"),
]


def shape_line(font_bytes, upem, text):
    """Return [(gid, cluster_text, advance_in_1000_units)] for one line."""
    blob = hb.glib_blob_create(__import__("gi").repository.GLib.Bytes.new(font_bytes))
    face = hb.face_create(blob, 0)
    font = hb.font_create(face)
    hb.font_set_scale(font, upem, upem)
    hb.ot_font_set_funcs(font)

    buf = hb.buffer_create()
    hb.buffer_add_utf8(buf, text.encode("utf-8"), 0, -1)
    hb.buffer_guess_segment_properties(buf)
    hb.shape(font, buf, [])

    infos = hb.buffer_get_glyph_infos(buf)
    positions = hb.buffer_get_glyph_positions(buf)

    # Map utf-8 byte offsets (HarfBuzz clusters) back to character slices.
    encoded = text.encode("utf-8")
    byte_to_char = {}
    char_index = 0
    byte_index = 0
    for ch in text:
        byte_to_char[byte_index] = char_index
        byte_index += len(ch.encode("utf-8"))
        char_index += 1
    byte_to_char[len(encoded)] = len(text)

    clusters = [info.cluster for info in infos]

    # Group consecutive glyphs that share a cluster.
    runs = []
    for i, cluster in enumerate(clusters):
        if runs and runs[-1][0] == cluster:
            runs[-1][1].append(i)
        else:
            runs.append((cluster, [i]))

    # Every glyph needs a non-empty ToUnicode entry: pdf.js reads
    # `toUnicode.get(code) || code`, so an empty destination silently falls
    # back to the raw character code and injects garbage. Instead of putting
    # a cluster's text on one glyph, spread the cluster's characters across
    # its glyphs in *logical* order. HarfBuzz emits glyphs in visual order,
    # but concatenating these labels in glyph order still reproduces the
    # original string — which is all extraction needs.
    assigned = [""] * len(infos)
    for run_index, (cluster, glyph_indices) in enumerate(runs):
        start = byte_to_char.get(cluster, 0)
        end_byte = runs[run_index + 1][0] if run_index + 1 < len(runs) else len(encoded)
        end = byte_to_char.get(end_byte, len(text))
        chars = text[start:end]
        n = len(glyph_indices)
        if n == 1 or len(chars) <= 1:
            assigned[glyph_indices[0]] = chars
        elif n <= len(chars):
            for k, gi_ in enumerate(glyph_indices[:-1]):
                assigned[gi_] = chars[k]
            assigned[glyph_indices[-1]] = chars[n - 1:]
        else:
            # More glyphs than characters: give each character its own glyph
            # and leave the surplus unmapped (reported by the round-trip check).
            for k, gi_ in enumerate(glyph_indices):
                assigned[gi_] = chars[k] if k < len(chars) else ""

    out = []
    for i, (info, pos) in enumerate(zip(infos, positions)):
        out.append((info.codepoint, assigned[i], pos.x_advance * 1000 / upem))
    return out


def utf16be_hex(text):
    return text.encode("utf-16-be").hex().upper()


def build_pdf(font_path, out_path):
    font_bytes = open(font_path, "rb").read()
    tt = TTFont(font_path, lazy=True)
    upem = tt["head"].unitsPerEm
    ascent = tt["hhea"].ascent * 1000 / upem
    descent = tt["hhea"].descent * 1000 / upem
    bbox = [
        int(tt["head"].xMin * 1000 / upem), int(tt["head"].yMin * 1000 / upem),
        int(tt["head"].xMax * 1000 / upem), int(tt["head"].yMax * 1000 / upem),
    ]

    cid_of = {}          # (gid, text) -> cid
    cid_gid = {}         # cid -> gid
    cid_text = {}        # cid -> source text
    cid_width = {}       # cid -> width /1000

    def cid_for(gid, text, width):
        key = (gid, text)
        if key not in cid_of:
            cid = len(cid_of) + 1
            cid_of[key] = cid
            cid_gid[cid] = gid
            cid_text[cid] = text
            cid_width[cid] = round(width)
        return cid_of[key]

    # Build the page content stream.
    parts = ["BT"]
    y = PAGE_H - MARGIN
    for text, size, script in LINES:
        if not text:
            y -= LINE_HEIGHT // 2
            continue
        if script == "latin":
            escaped = text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
            parts.append(f"/F2 {size} Tf 1 0 0 1 {MARGIN} {y:.0f} Tm ({escaped}) Tj")
            y -= LINE_HEIGHT
            continue
        glyphs = shape_line(font_bytes, upem, text)

        # A fixture that does not round-trip is worse than no fixture.
        roundtrip = "".join(txt for _, txt, _ in glyphs)
        if roundtrip != text:
            raise SystemExit(
                "ToUnicode round-trip failed for a line.\n"
                f"  expected: {text!r}\n"
                f"  produced: {roundtrip!r}"
            )

        codes = "".join(
            f"{cid_for(gid, txt, adv):04X}" for gid, txt, adv in glyphs
        )
        parts.append(f"/F1 {size} Tf 1 0 0 1 {MARGIN} {y:.0f} Tm <{codes}> Tj")
        y -= LINE_HEIGHT
    parts.append("ET")
    content = "\n".join(parts).encode("latin-1")

    max_cid = len(cid_of)

    # CIDToGIDMap: 2 bytes per CID, indexed by CID.
    cid_to_gid = bytearray(2 * (max_cid + 1))
    for cid, gid in cid_gid.items():
        cid_to_gid[cid * 2] = (gid >> 8) & 0xFF
        cid_to_gid[cid * 2 + 1] = gid & 0xFF

    # ToUnicode CMap. Every CID needs an entry, including the non-initial
    # glyphs of a cluster: those map to the empty string so the cluster's
    # text is contributed exactly once. Without an entry a reader falls
    # back to treating the CID as a character code and emits garbage.
    entries = [
        f"<{cid:04X}> <{utf16be_hex(t)}>"
        for cid, t in sorted(cid_text.items())
    ]
    chunks = [entries[i:i + 100] for i in range(0, len(entries), 100)]
    bf = "\n".join(
        f"{len(chunk)} beginbfchar\n" + "\n".join(chunk) + "\nendbfchar"
        for chunk in chunks
    )
    tounicode = f"""/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Gloss-Fixture def
/CMapType 2 def
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
{bf}
endcmap
CMapName currentdict /CMap defineresource pop
end
end""".encode("latin-1")

    widths = " ".join(
        f"{cid} [{cid_width[cid]}]" for cid in sorted(cid_width)
    )

    objects = []

    def add(body, stream=None, compress=False):
        objects.append((body, stream, compress))
        return len(objects)

    font_file_id = add("<< /Length1 %d >>" % len(font_bytes), font_bytes, True)
    descriptor_id = add(
        f"<< /Type /FontDescriptor /FontName /GlossDeva /Flags 4 "
        f"/FontBBox [{bbox[0]} {bbox[1]} {bbox[2]} {bbox[3]}] /ItalicAngle 0 "
        f"/Ascent {ascent:.0f} /Descent {descent:.0f} /CapHeight {ascent:.0f} "
        f"/StemV 80 /FontFile2 {font_file_id} 0 R >>"
    )
    cid_map_id = add("<< >>", bytes(cid_to_gid), True)
    descendant_id = add(
        f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /GlossDeva "
        f"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
        f"/FontDescriptor {descriptor_id} 0 R /DW 600 /W [{widths}] "
        f"/CIDToGIDMap {cid_map_id} 0 R >>"
    )
    tounicode_id = add("<< >>", tounicode, True)
    font_id = add(
        f"<< /Type /Font /Subtype /Type0 /BaseFont /GlossDeva "
        f"/Encoding /Identity-H /DescendantFonts [{descendant_id} 0 R] "
        f"/ToUnicode {tounicode_id} 0 R >>"
    )
    latin_font_id = add(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
        "/Encoding /WinAnsiEncoding >>"
    )
    content_id = add("<< >>", content, True)
    pages_id = len(objects) + 3
    page_id = add(
        f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
        f"/Resources << /Font << /F1 {font_id} 0 R /F2 {latin_font_id} 0 R >> >> "
        f"/Contents {content_id} 0 R >>"
    )
    real_pages_id = add(f"<< /Type /Pages /Kids [{page_id} 0 R] /Count 1 >>")
    catalog_id = add(f"<< /Type /Catalog /Pages {real_pages_id} 0 R >>")

    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, (body, stream, compress) in enumerate(objects):
        offsets.append(len(out))
        out += f"{i + 1} 0 obj\n".encode("latin-1")
        if stream is None:
            out += body.encode("latin-1") + b"\n"
        else:
            data = zlib.compress(stream) if compress else stream
            extra = "/Filter /FlateDecode " if compress else ""
            dict_body = body.rstrip()
            assert dict_body.endswith(">>")
            dict_body = dict_body[:-2] + f" {extra}/Length {len(data)} >>"
            out += dict_body.encode("latin-1") + b"\nstream\n" + data + b"\nendstream\n"
        out += b"endobj\n"

    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("latin-1")
    for i in range(1, len(objects) + 1):
        out += f"{offsets[i]:010d} 00000 n \n".encode("latin-1")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    ).encode("latin-1")

    open(out_path, "wb").write(bytes(out))
    print(f"wrote {out_path} ({max_cid} CIDs, {len(out)} bytes)")


if __name__ == "__main__":
    build_pdf(sys.argv[1], sys.argv[2])

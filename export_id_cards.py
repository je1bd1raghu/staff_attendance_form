#!/usr/bin/env python3
"""
export_id_cards.py  —  ID card batch exporter (ReportLab, no browser needed)
-----------------------------------------------------------------------------
Fetches employees from the Cloudflare Worker and draws every ID card in a
2×2 grid on A4 pages.  All measurements come directly from the printIdCard()
CSS in app.js, so the layout matches the browser print output.

Requirements:
    pip install reportlab "qrcode[pil]" requests --break-system-packages

Usage:
    python export_id_cards.py
    python export_id_cards.py --out batch_june.pdf
    python export_id_cards.py --filter "Sales"
"""

import argparse, base64, hashlib, io, sys
from datetime import datetime

import qrcode, requests
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT

WORKER_URL = "https://attendance-proxy.je1-bd1-raghu.workers.dev/"

# ══════════════════════════════════════════════════════════════════════════════
#  LAYOUT CONSTANTS  (all derived from printIdCard CSS, mm → points)
# ══════════════════════════════════════════════════════════════════════════════
MM   = 2.83465          # 1 mm in points
A4W, A4H = A4           # 595.276 × 841.890 pt

# Page grid  —  .page { padding:10mm; gap:6mm }
PAGE_PAD = 10 * MM
PAGE_GAP =  6 * MM
CW = (A4W - 2*PAGE_PAD - PAGE_GAP) / 2   # 260.788 pt = 92.00 mm
CH = (A4H - 2*PAGE_PAD - PAGE_GAP) / 2   # 384.095 pt = 135.50 mm

# Section heights  (top → bottom inside card)
# .card-hdr { padding:3.5mm 4mm }  8pt Nunito lh≈1.2
HDR_PAD_V  = 3.5 * MM
HDR_TXT_H  = 8 * 1.2               # ≈9.6 pt
HDR_H      = HDR_PAD_V + HDR_TXT_H + HDR_PAD_V   # ≈29.4 pt

# .top-sec { padding:4mm 4.5mm }  photo-box 28mm tall
TOP_PAD_V  = 4.0 * MM
TOP_PAD_H  = 4.5 * MM
TOP_H      = TOP_PAD_V + 28*MM + TOP_PAD_V        # ≈102.0 pt

# .divider { height:0.3mm }
DIV_H      = 0.3 * MM                             # ≈0.85 pt

# .bottom-sec { padding:3mm 4.5mm 4mm }
# qr-wrap: 2mm pad + 78px img + 2mm pad  (78px @96dpi = 20.64mm)
BOT_PAD_T  = 3.0 * MM
BOT_PAD_H  = 4.5 * MM
BOT_PAD_B  = 4.0 * MM
QR_IMG_PT  = (78 / 96 * 25.4) * MM               # ≈58.50 pt
QR_PAD     = 2.0 * MM
QR_WRAP_SZ = QR_PAD + QR_IMG_PT + QR_PAD         # ≈69.84 pt (square)
BOT_H      = BOT_PAD_T + QR_WRAP_SZ + BOT_PAD_B  # ≈89.68 pt

# .fields-sec { flex:1; padding:3mm 4.5mm; justify-content:space-between }
# 6 rows, space-between → 5 equal gaps
FLD_H      = CH - HDR_H - TOP_H - DIV_H - DIV_H - BOT_H   # ≈161.2 pt
FLD_PAD_V  = 3.0 * MM
FLD_PAD_H  = 4.5 * MM
FLD_INNER  = FLD_H - 2 * FLD_PAD_V                         # ≈144.2 pt
FLD_STEP   = FLD_INNER / 5   # step between row baselines, space-between

# .fline { height:4.5mm }
FROW_H     = 4.5 * MM

# top-sec internals
PH_W       = 22 * MM                    # photo-box width
PH_H       = 28 * MM                    # photo-box height
NB_GAP     = 3.5 * MM                   # gap between photo and name-block
NB_X_OFF   = TOP_PAD_H + PH_W + NB_GAP # x offset of name-block from card left
NB_W       = CW - NB_X_OFF - TOP_PAD_H  # name-block width ≈57.5mm

# name-block item gaps  —  .name-block { gap:1.2mm; padding-top:0.5mm }
NB_PAD_T   = 0.5 * MM
NB_GAP_IT  = 1.2 * MM

# ══════════════════════════════════════════════════════════════════════════════
#  COLOURS  (verbatim from printIdCard CSS)
# ══════════════════════════════════════════════════════════════════════════════
C_DARK    = colors.HexColor("#212529")
C_WHITE   = colors.white
C_ORANGE  = colors.HexColor("#F5821F")
C_MUTED   = colors.HexColor("#adb5bd")
C_LABEL   = colors.HexColor("#495057")
C_DIVIDER = colors.HexColor("#dee2e6")
C_PHOTO   = colors.HexColor("#f8f9fa")
C_QRBG    = colors.HexColor("#fff4ec")


# ══════════════════════════════════════════════════════════════════════════════
#  HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def emp_uuid(emp_id, name, designation):
    """SHA-1 UUID v5 — mirrors getEmpUuid() in app.js."""
    seed = f"{emp_id}|{name}|{designation or ''}"
    b = bytearray(hashlib.sha1(seed.encode()).digest())
    b[6] = (b[6] & 0x0F) | 0x50
    b[8] = (b[8] & 0x3F) | 0x80
    h = b.hex()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def make_qr(payload):
    """Return a QR PIL image for the given payload."""
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,
                       box_size=8, border=2)
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#212529", back_color="white").convert("RGB")
    px = max(int(QR_IMG_PT * 3), 200)
    img = img.resize((px, px))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf


_DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]
_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun",
           "Jul","Aug","Sep","Oct","Nov","Dec"]

def fmt_stamp(d):
    """mirrors formatPrintedOn() in app.js."""
    dow = _DAYS[d.isoweekday() % 7]
    return (f"Printed on {dow}, {d.day} {_MONTHS[d.month-1]} {d.year}"
            f" {d.hour:02d}:{d.minute:02d}:{d.second:02d}")


def resolve_zones(emp, locations):
    ids = emp.get("locationIds") or []
    pool = ([l["name"] for l in locations if l["id"] in ids]
            if ids else [l["name"] for l in locations])
    return ", ".join(pool)


def fit_text(c, text, font, size, max_w):
    """Trim text with ellipsis to fit within max_w points."""
    if c.stringWidth(text, font, size) <= max_w:
        return text
    while text and c.stringWidth(text + "…", font, size) > max_w:
        text = text[:-1]
    return text + "…"


def slot_origin(idx):
    """Bottom-left corner of card slot 0=TL 1=TR 2=BL 3=BR."""
    col = idx % 2
    row = idx // 2
    x = PAGE_PAD + col * (CW + PAGE_GAP)
    y = A4H - PAGE_PAD - (row + 1) * CH - row * PAGE_GAP
    return x, y


# ══════════════════════════════════════════════════════════════════════════════
#  CARD DRAWING
# ══════════════════════════════════════════════════════════════════════════════
# Origin (cx, cy) = bottom-left corner of the card.
# All y positions are computed from section boundaries derived above.
#
# Section map (y from top of card = cy+CH):
#   cy+CH          ┐
#   cy+CH-HDR_H    ┤  .card-hdr
#   cy+CH-HDR_H-TOP_H ┤ .top-sec
#   ... -DIV_H     ┤  divider 1
#   ... -FLD_H     ┤  .fields-sec
#   ... -DIV_H     ┤  divider 2
#   cy             ┘  .bottom-sec

def draw_card(c, cx, cy, emp, locations, printed_at):
    name  = emp.get("name", "")
    desig = emp.get("designation", "")
    empid = emp.get("id", "")
    zones = resolve_zones(emp, locations)

    # ── pre-compute section y-boundaries (all in ReportLab coords) ───────────
    hdr_top    = cy + CH
    hdr_bot    = hdr_top  - HDR_H
    top_top    = hdr_bot
    top_bot    = top_top  - TOP_H
    div1_top   = top_bot
    div1_bot   = div1_top - DIV_H
    fld_top    = div1_bot
    fld_bot    = fld_top  - FLD_H
    div2_top   = fld_bot
    div2_bot   = div2_top - DIV_H
    bot_top    = div2_bot
    # bot_bot  = cy

    # ── outer border: 1.5px dashed #adb5bd, border-radius:4mm ───────────────
    c.setStrokeColor(C_MUTED)
    c.setLineWidth(1.5)
    c.setDash(4, 3)
    c.roundRect(cx, cy, CW, CH, radius=4*MM, stroke=1, fill=0)
    c.setDash()

    # ── .card-hdr ────────────────────────────────────────────────────────────
    # background:#212529; top two corners rounded, bottom two square
    c.setFillColor(C_DARK)
    c.setLineWidth(0)
    c.roundRect(cx, hdr_bot, CW, HDR_H, radius=4*MM, stroke=0, fill=1)
    # square off the bottom half of the rounded rect
    c.rect(cx, hdr_bot, CW, HDR_H / 2, stroke=0, fill=1)

    # .ttl: 8pt 800 white centred uppercase
    c.setFillColor(C_WHITE)
    c.setFont("Helvetica-Bold", 8)
    text_y = hdr_bot + (HDR_H - 8) / 2   # vertically centred
    c.drawCentredString(cx + CW / 2, text_y, "EMPLOYEE ID CARD")

    # ── .top-sec ─────────────────────────────────────────────────────────────
    ph_x = cx + TOP_PAD_H
    ph_y = top_bot + TOP_PAD_V          # bottom of photo-box

    # .photo-box: 22×28mm, border:1px #adb5bd, radius:2mm, bg:#f8f9fa
    c.setFillColor(C_PHOTO)
    c.setStrokeColor(C_MUTED)
    c.setLineWidth(0.7)
    c.roundRect(ph_x, ph_y, PH_W, PH_H, radius=2*MM, stroke=1, fill=1)
    c.setFillColor(C_MUTED)
    c.setFont("Helvetica-Bold", 6)
    c.drawCentredString(ph_x + PH_W/2, ph_y + PH_H/2 - 3, "PHOTO")

    # .name-block: starts at photo right + NB_GAP, padding-top:0.5mm
    nb_x    = cx + NB_X_OFF
    # Start cursor at the TOP of top-sec content area, move down
    cursor  = top_top - TOP_PAD_V - NB_PAD_T   # top of name-block

    # .printed-name: 10pt 800 #212529 lh1.2
    FONT_NAME = 8          # using 8pt for ReportLab (Helvetica ≈ Nunito 10pt visually)
    LH_NAME   = 10 * 1.2
    cursor   -= LH_NAME
    c.setFillColor(C_DARK)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(nb_x, cursor + (LH_NAME - 10)/2,
                 fit_text(c, name, "Helvetica-Bold", 10, NB_W))
    cursor -= NB_GAP_IT

    # .printed-desig: 7pt 700 #F5821F margin-bottom:0.5mm
    if desig:
        LH_DESIG = 7 * 1.2
        cursor  -= LH_DESIG
        c.setFillColor(C_ORANGE)
        c.setFont("Helvetica-Bold", 7)
        c.drawString(nb_x, cursor + (LH_DESIG - 7)/2,
                     fit_text(c, desig, "Helvetica-Bold", 7, NB_W))
        cursor -= 0.5*MM + NB_GAP_IT

    # .printed-id: 6pt 700 monospace #adb5bd margin-bottom:1.5mm
    LH_ID  = 6 * 1.2
    cursor -= LH_ID
    c.setFillColor(C_MUTED)
    c.setFont("Courier-Bold", 6)
    c.drawString(nb_x, cursor + (LH_ID - 6)/2, empid)
    cursor -= 1.5*MM + NB_GAP_IT

    # two .field-row inside name-block (Dept, DOJ)
    for lbl in ("Dept", "DOJ"):
        cursor -= FROW_H
        _frow(c, nb_x, cursor, NB_W, lbl, short=False)
        cursor -= NB_GAP_IT

    # ── divider 1 ─────────────────────────────────────────────────────────────
    _divider(c, cx, div1_top)

    # ── .fields-sec (6 rows, space-between) ──────────────────────────────────
    # Row 0 is at top of inner area, row 5 at bottom.
    # space-between: row i top = fld_top - FLD_PAD_V - i * FLD_STEP
    fs_x = cx + FLD_PAD_H
    fs_w = CW - 2 * FLD_PAD_H

    ROWS = [
        ("Blood Gr",   True,  False),   # (label, short_line, is_zones)
        ("Mobile",     False, False),
        ("Emergency",  False, False),
        ("Issue Date", False, False),
        ("Valid Until",False, False),
        ("Allowed",    False, True),
    ]

    for i, (lbl, short, is_zones) in enumerate(ROWS):
        row_top = fld_top - FLD_PAD_V - i * FLD_STEP
        row_bot = row_top - FROW_H   # baseline area

        if is_zones:
            # .fval: no underline, wrapping orange text, align-items:flex-start
            # label at top of row
            c.setFillColor(C_LABEL)
            c.setFont("Helvetica-Bold", 6)
            c.drawString(fs_x, row_top - 6, lbl.upper())

            # zones text wraps — draw with Paragraph for word-wrap
            val_x = fs_x + 14*MM
            val_w = fs_w - 14*MM
            _draw_zones(c, val_x, row_top, val_w, zones)
        else:
            _frow(c, fs_x, row_bot, fs_w, lbl, short=short)

    # ── divider 2 ─────────────────────────────────────────────────────────────
    _divider(c, cx, div2_top)

    # ── .bottom-sec ───────────────────────────────────────────────────────────
    # align-items:flex-end  → everything anchored to bottom  (cy + BOT_PAD_B)
    content_bot = cy + BOT_PAD_B

    # .qr-col: stamp rotated 90°, single line, left of qr-wrap
    # The stamp spans the full bottom-sec inner height so it always fits.
    # Layout (left→right): [BOT_PAD_H] [stamp 4.5pt rotated] [2mm gap] [qr-wrap] [3mm gap] [sig-col]
    STAMP_FS  = 4.5
    STAMP_W   = STAMP_FS + 1*MM   # strip width = font size + small breathing room

    # Full available vertical span for the rotated stamp = QR_WRAP_SZ (qr-wrap height)
    # but anchored to content_bot so it aligns flush with the qr-wrap
    qw_x = cx + BOT_PAD_H + STAMP_W + 2*MM   # qr-wrap x: after stamp strip + gap
    qw_y = content_bot                         # bottom of qr-wrap

    # Draw stamp: rotated 90° CCW so it reads bottom-to-top on the left
    stamp = fmt_stamp(printed_at)
    c.setFillColor(C_MUTED)
    c.setFont("Helvetica", STAMP_FS)
    sw = c.stringWidth(stamp, "Helvetica", STAMP_FS)   # text length in points
    # Centre the stamp over the full bot-sec inner height (QR wrap + top padding above it)
    # so the text is never clipped — the full span is qw_y to qw_y+QR_WRAP_SZ+BOT_PAD_T
    avail_h  = QR_WRAP_SZ + BOT_PAD_T
    text_offset = (avail_h - sw) / 2
    stamp_bx = cx + BOT_PAD_H + STAMP_FS   # baseline x of rotated text
    stamp_by = qw_y + text_offset           # baseline y start
    c.saveState()
    c.translate(stamp_bx, stamp_by)
    c.rotate(90)
    c.drawString(0, 0, stamp)
    c.restoreState()

    # qr-wrap bg: #fff4ec, radius:2.5mm
    c.setFillColor(C_QRBG)
    c.roundRect(qw_x, qw_y, QR_WRAP_SZ, QR_WRAP_SZ,
                radius=2.5*MM, stroke=0, fill=1)

    # QR image inside wrap
    uuid    = emp_uuid(empid, name, desig)
    payload = f"{uuid}|{printed_at.isoformat()}"
    qr_buf  = make_qr(payload)
    c.drawImage(rl_canvas.ImageReader(qr_buf),
                qw_x + QR_PAD, qw_y + QR_PAD,
                QR_IMG_PT, QR_IMG_PT,
                preserveAspectRatio=True, mask="auto")

    # .sig-col: flex:1, align-items:center, justify-content:flex-end, padding-bottom:1mm
    sig_x1 = qw_x + QR_WRAP_SZ + 3*MM     # gap:3mm
    sig_x2 = cx + CW - BOT_PAD_H
    sig_cx  = (sig_x1 + sig_x2) / 2

    # .sig-label: 5.5pt 800 #495057 uppercase centred, at bottom + 1mm pad
    label_y = content_bot + 1*MM
    c.setFillColor(C_LABEL)
    c.setFont("Helvetica-Bold", 5.5)
    c.drawCentredString(sig_cx, label_y, "AUTHORIZED SIGNATURE")

    # .sig-line: border-bottom:0.8px #212529, margin-bottom:2mm, height:10mm
    line_y = label_y + 5.5 + 2*MM
    c.setStrokeColor(C_DARK)
    c.setLineWidth(0.8)
    c.line(sig_x1, line_y, sig_x2, line_y)


def _divider(c, cx, top_y):
    """Draw a 0.3mm #dee2e6 divider with 4mm horizontal margin."""
    mid = top_y - DIV_H / 2
    c.setStrokeColor(C_DIVIDER)
    c.setLineWidth(DIV_H)
    c.line(cx + 4*MM, mid, cx + CW - 4*MM, mid)


def _frow(c, x, y, w, label, short):
    """
    Draw one field row: label + underline.
    y = bottom of the row's 4.5mm height box.
    .flabel: 6pt 800 #495057 uppercase, min-width:14mm
    .fline:  border-bottom:0.8px #212529, height:4.5mm
    .fline.short: max-width:13mm
    """
    LABEL_W = 14 * MM
    c.setFillColor(C_LABEL)
    c.setFont("Helvetica-Bold", 6)
    c.drawString(x, y + 1, label.upper())
    val_x    = x + LABEL_W
    line_end = val_x + (13*MM if short else w - LABEL_W)
    c.setStrokeColor(C_DARK)
    c.setLineWidth(0.8)
    c.line(val_x, y, line_end, y)


def _draw_zones(c, x, row_top, w, text):
    """
    .fval: 6.5pt 700 #F5821F, white-space:normal, word-break:break-word
    No underline. Starts at top of row (align-items:flex-start).
    Wraps manually word by word.
    """
    if not text:
        return
    c.setFillColor(C_ORANGE)
    c.setFont("Helvetica-Bold", 6.5)
    LH = 6.5 * 1.4   # line-height:1.4 from CSS

    words = text.split()
    line  = ""
    y     = row_top - 6.5   # first baseline

    for word in words:
        test = (line + " " + word).strip()
        if c.stringWidth(test, "Helvetica-Bold", 6.5) <= w:
            line = test
        else:
            if line:
                c.drawString(x, y, line)
                y    -= LH
                line  = word
            else:
                # single word wider than column — draw it truncated
                c.drawString(x, y, fit_text(c, word, "Helvetica-Bold", 6.5, w))
                y    -= LH
                line  = ""
    if line:
        c.drawString(x, y, line)


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser(
        description="Export all ID cards to PDF (2×2 per A4 page).")
    ap.add_argument("--out",    default="id_cards_all.pdf")
    ap.add_argument("--filter", default="",
                    help="Include only employees matching this name/designation")
    ap.add_argument("--worker", default=WORKER_URL)
    args = ap.parse_args()

    print(f"Fetching config from {args.worker} …")
    try:
        r = requests.get(args.worker + "config", timeout=15)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        sys.exit(f"ERROR: {e}")

    employees = sorted(data.get("employees", []),
                       key=lambda e: e.get("name", ""))
    locations = data.get("locations", [])
    print(f"  {len(employees)} employees, {len(locations)} locations.")

    if args.filter:
        q = args.filter.lower()
        employees = [e for e in employees
                     if q in e.get("name","").lower()
                     or q in e.get("designation","").lower()]
        print(f"  {len(employees)} after filter '{args.filter}'.")

    if not employees:
        sys.exit("No employees to export.")

    printed_at = datetime.now()
    total      = len(employees)
    pages      = (total + 3) // 4
    print(f"Drawing {total} cards on {pages} page(s) …")

    c = rl_canvas.Canvas(args.out, pagesize=A4)
    c.setTitle("Employee ID Cards")

    for i, emp in enumerate(employees):
        if i > 0 and i % 4 == 0:
            c.showPage()
        sx, sy = slot_origin(i % 4)
        print(f"  [{i+1}/{total}] {emp.get('name','')} ({emp.get('id','')})",
              flush=True)
        draw_card(c, sx, sy, emp, locations, printed_at)

    c.save()
    print(f"\n✅  Saved → {args.out}  ({total} cards, {pages} pages)")


if __name__ == "__main__":
    main()

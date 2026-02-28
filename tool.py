#!/usr/bin/env python3
"""
pdf_to_reader_txt.py

Goal:
- Extract text from a PDF with much better cleanup than a raw dump.
- Fix common PDF artifacts (ligatures, broken hyphenation, line-wrap joins).
- Remove common running headers/footers (page numbers, "Chapter ..." headers, etc.).
- Preserve code/pseudocode blocks by keeping indentation and line breaks.
- Write a single .txt output (optionally also a JSON-ish per-page block if you want).

Dependencies:
  pip install pymupdf

Usage:
  python pdf_to_reader_txt.py input.pdf output.txt
  python pdf_to_reader_txt.py input.pdf output.txt --start 1 --end 20
  python pdf_to_reader_txt.py input.pdf output.txt --keep-page-breaks
  python pdf_to_reader_txt.py input.pdf output.txt --debug

Notes:
- Header/footer removal is heuristic; tune patterns for your PDF if needed.
"""

from __future__ import annotations
import argparse
import re
from dataclasses import dataclass
from typing import List, Tuple, Optional
import fitz  # PyMuPDF


# ----------------------------
# Normalization / Fixups
# ----------------------------

LIGATURES = {
    "\uFB00": "ff",  # ﬀ
    "\uFB01": "fi",  # ﬁ
    "\uFB02": "fl",  # ﬂ
    "\uFB03": "ffi", # ﬃ
    "\uFB04": "ffl", # ﬄ
}

def normalize_unicode(s: str) -> str:
    for k, v in LIGATURES.items():
        s = s.replace(k, v)
    # common quotes/dashes
    s = s.replace("\u2018", "'").replace("\u2019", "'")
    s = s.replace("\u201C", '"').replace("\u201D", '"')
    s = s.replace("\u2013", "-").replace("\u2014", "-")
    # NBSP -> space
    s = s.replace("\u00A0", " ")
    # strip trailing spaces per line later
    return s

def looks_like_header_or_footer(line: str) -> bool:
    t = line.strip()
    if not t:
        return False

    # pure page number
    if re.fullmatch(r"\d{1,4}", t):
        return True

    # running header patterns typical of textbooks:
    # "8 Chapter 1 The Role of Algorithms in Computing"
    if re.match(r"^\d+\s+(Chapter|Part)\s+\d+\b", t, flags=re.I):
        return True

    # "1.1 Algorithms 7" style header: section title + trailing page number
    if re.match(r"^\d+(\.\d+)*\s+.+\s+\d{1,4}$", t):
        # avoid false positives: require mostly letters
        letters = sum(c.isalpha() for c in t)
        if letters >= 6:
            return True

    # "Chapter notes" etc with trailing page numbers can appear too
    # keep conservative; you can add more patterns here
    return False

def is_code_like(line: str) -> bool:
    # strong indentation => code/pseudocode
    return bool(re.match(r"^\s{2,}\S", line))

def is_list_like(line: str) -> bool:
    t = line.lstrip()
    return bool(re.match(r"^([*•\-])\s+\S", t) or re.match(r"^\d+([.)]|\.\d+)?\s+\S", t))

def is_heading_like(line: str) -> bool:
    t = line.strip()
    if len(t) < 3 or len(t) > 80:
        return False
    if t.endswith("."):
        return False
    if re.match(r"^(Chapter|Part)\b", t, flags=re.I):
        return True
    if re.match(r"^\d+(\.\d+)*\s+\S", t):
        return True
    # Title-ish: low punctuation density
    punct = len(re.findall(r"[,:;()]", t))
    if punct > 1:
        return False
    # Avoid all-caps noise lines
    if t.isupper() and len(t) > 50:
        return False
    return True

def dehyphenate_join(prev: str, nxt: str) -> Optional[str]:
    """
    If prev ends with hyphen and nxt begins with lowercase, join without space/hyphen.
    Example: "com-" + "puting" -> "computing"
    """
    if prev.endswith("-") and nxt and nxt[0].islower():
        return prev[:-1] + nxt
    return None


# ----------------------------
# Page extraction strategy
# ----------------------------

def extract_lines_with_layout(page: fitz.Page) -> List[str]:
    """
    Use get_text("blocks") for a more layout-aware extraction than get_text("text").
    We then order blocks top-to-bottom, left-to-right, and split into lines.
    """
    blocks = page.get_text("blocks")  # list of (x0,y0,x1,y1,"text",block_no,block_type)
    # Keep text blocks only
    blocks = [b for b in blocks if isinstance(b[4], str) and b[4].strip()]
    # Sort by y then x
    blocks.sort(key=lambda b: (round(b[1], 1), round(b[0], 1)))

    lines: List[str] = []
    for b in blocks:
        txt = normalize_unicode(b[4])
        # split into lines, keep indentation-ish by preserving leading spaces as extracted
        for ln in txt.splitlines():
            ln = ln.rstrip()
            if ln == "":
                lines.append("")
            else:
                lines.append(ln)
        # block separator: blank line
        lines.append("")
    # normalize multiple blanks later
    return lines


# ----------------------------
# Cleaner + Reflow
# ----------------------------

def strip_headers_footers(lines: List[str]) -> List[str]:
    """
    Conservative removal: drop lines that match header/footer patterns.
    Applied to all lines; if you want only top/bottom region logic, you can add it later.
    """
    out = []
    for ln in lines:
        if looks_like_header_or_footer(ln):
            continue
        out.append(ln)
    return out

def collapse_blank_runs(lines: List[str], max_blanks: int = 1) -> List[str]:
    out = []
    blank_run = 0
    for ln in lines:
        if ln.strip() == "":
            blank_run += 1
            if blank_run <= max_blanks:
                out.append("")
        else:
            blank_run = 0
            out.append(ln)
    # trim ends
    while out and out[0].strip() == "":
        out.pop(0)
    while out and out[-1].strip() == "":
        out.pop()
    return out

def reflow_paragraph_lines(lines: List[str]) -> List[str]:
    """
    Merge hard-wrapped lines into paragraphs, but:
    - Preserve code blocks (indented)
    - Preserve list items as separate lines, but merge wrapped continuation lines into the item
    - Preserve headings as their own line with blank lines around
    """
    out: List[str] = []
    i = 0
    n = len(lines)

    def emit_blank():
        if out and out[-1] != "":
            out.append("")

    while i < n:
        ln = lines[i]
        t = ln.strip()

        if not t:
            emit_blank()
            i += 1
            continue

        # Code block: keep as-is until a blank line separates (or indentation stops)
        if is_code_like(ln):
            emit_blank()
            code_buf = []
            while i < n and (lines[i].strip() == "" or is_code_like(lines[i])):
                code_buf.append(lines[i].rstrip())
                i += 1
            # trim leading/trailing blanks inside code
            while code_buf and code_buf[0].strip() == "":
                code_buf.pop(0)
            while code_buf and code_buf[-1].strip() == "":
                code_buf.pop()
            out.extend(code_buf)
            emit_blank()
            continue

        # Heading: standalone line (if surrounded by blank or looks like heading)
        if is_heading_like(ln):
            emit_blank()
            out.append(t)
            emit_blank()
            i += 1
            continue

        # List item: merge continuations that are not new list items/code/headings
        if is_list_like(ln):
            buf = [t]
            i += 1
            while i < n:
                nxt = lines[i]
                nt = nxt.strip()
                if not nt:
                    break
                if is_list_like(nxt) or is_code_like(nxt) or is_heading_like(nxt):
                    break
                # join continuation with space / dehyphenate
                joined = dehyphenate_join(buf[-1], nt)
                if joined is not None:
                    buf[-1] = joined
                else:
                    buf[-1] = buf[-1] + " " + nt
                i += 1
            out.append(buf[-1])
            # consume any blanks after item
            while i < n and lines[i].strip() == "":
                emit_blank()
                i += 1
            continue

        # Paragraph: merge until blank or structural line
        para = t
        i += 1
        while i < n:
            nxt = lines[i]
            nt = nxt.strip()
            if not nt:
                break
            if is_code_like(nxt) or is_list_like(nxt) or is_heading_like(nxt):
                break

            joined = dehyphenate_join(para, nt)
            if joined is not None:
                para = joined
            else:
                para = para + " " + nt
            i += 1

        out.append(para)

        # eat trailing blanks after paragraph
        while i < n and lines[i].strip() == "":
            emit_blank()
            i += 1

    return collapse_blank_runs(out, max_blanks=1)


# ----------------------------
# Page assembly
# ----------------------------

@dataclass
class PageText:
    page_num: int
    lines: List[str]

def process_page(page: fitz.Page, page_num: int, debug: bool=False) -> PageText:
    raw_lines = extract_lines_with_layout(page)
    raw_lines = [ln.rstrip() for ln in raw_lines]
    raw_lines = strip_headers_footers(raw_lines)
    raw_lines = collapse_blank_runs(raw_lines, max_blanks=2)
    cleaned = reflow_paragraph_lines(raw_lines)

    if debug:
        # Print a short diagnostic summary
        code_lines = sum(1 for ln in cleaned if is_code_like(ln))
        print(f"[debug] page {page_num}: raw={len(raw_lines)} lines -> cleaned={len(cleaned)} lines (code_lines={code_lines})")

    return PageText(page_num=page_num, lines=cleaned)

def format_pages(pages: List[PageText], keep_page_breaks: bool) -> str:
    parts: List[str] = []
    for p in pages:
        if keep_page_breaks:
            parts.append(f"=== PAGE {p.page_num} ===")
        parts.extend(p.lines)
        if keep_page_breaks:
            parts.append("")  # blank after each page
        else:
            # Still separate pages by a blank line to avoid accidental merges
            parts.append("")
    # final cleanup
    txt = "\n".join(parts).rstrip() + "\n"
    return txt


# ----------------------------
# CLI
# ----------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", help="input PDF path")
    ap.add_argument("out", help="output .txt path")
    ap.add_argument("--start", type=int, default=1, help="start page (1-based)")
    ap.add_argument("--end", type=int, default=0, help="end page (1-based, inclusive). 0 = last page")
    ap.add_argument("--keep-page-breaks", action="store_true", help="write explicit page markers")
    ap.add_argument("--debug", action="store_true", help="print debug info")
    args = ap.parse_args()

    doc = fitz.open(args.pdf)
    start = max(1, args.start)
    end = args.end if args.end else doc.page_count
    end = min(end, doc.page_count)
    if start > end:
        raise SystemExit(f"start ({start}) > end ({end})")

    pages: List[PageText] = []
    for pno in range(start, end + 1):
        page = doc.load_page(pno - 1)
        pages.append(process_page(page, pno, debug=args.debug))

    out_txt = format_pages(pages, keep_page_breaks=args.keep_page_breaks)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(out_txt)

    if args.debug:
        print(f"[debug] wrote {args.out} ({len(out_txt)} chars)")

if __name__ == "__main__":
    main()
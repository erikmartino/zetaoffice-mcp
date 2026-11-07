#!/usr/bin/env python3
"""Mechanical checks for the benchmark prompts (see docs/benchmark.md).

Usage: python3 scripts/bench_check.py <id> [output_dir]
Prints one line per check and exits 0 only when all checks pass.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = json.load(open(os.path.join(ROOT, "bench", "prompts.json")))


def find_files(directory, ext):
    out = []
    for base, _dirs, files in os.walk(directory):
        for f in files:
            if f.lower().endswith(ext):
                out.append(os.path.join(base, f))
    return sorted(out)


def zip_names(path):
    try:
        with zipfile.ZipFile(path) as z:
            return z.namelist()
    except Exception:
        return []


def zip_text(path, name):
    try:
        with zipfile.ZipFile(path) as z:
            return z.read(name).decode("utf-8", "replace")
    except Exception:
        return ""


def pdf_text(path):
    try:
        r = subprocess.run(["pdftotext", path, "-"], capture_output=True, text=True, timeout=20)
        return r.stdout
    except Exception:
        return ""


def size_ok(path, minimum):
    try:
        return os.path.getsize(path) >= minimum
    except OSError:
        return False


def first(directory, ext):
    files = find_files(directory, ext)
    return files[0] if files else None


def check_a1(d):
    odt, pdf = first(d, ".odt"), first(d, ".pdf")
    xml = zip_text(odt, "content.xml") if odt else ""
    return [
        ("odt exists > 5KB", bool(odt) and size_ok(odt, 5000), odt),
        ("pdf exists > 5KB", bool(pdf) and size_ok(pdf, 5000), pdf),
        ("title style", 'text:style-name="Title"' in xml, ""),
        ("title text", "Notice of Inspection" in xml, ""),
        ("date line", bool(re.search(r"\b(20\d{2}|January|February|March|April|May|June|July|August|September|October|November|December)\b", xml)), ""),
    ]


def check_a2(d):
    xlsx = first(d, ".xlsx")
    names = zip_names(xlsx) if xlsx else []
    sheet = zip_text(xlsx, "xl/worksheets/sheet1.xml") if xlsx else ""
    styles = zip_text(xlsx, "xl/styles.xml") if xlsx else ""
    return [
        ("xlsx exists", bool(xlsx), xlsx),
        ("chart1.xml", "xl/charts/chart1.xml" in names, ""),
        ("numeric values >= 5", len(re.findall(r"<v>-?\d+(?:\.\d+)?</v>", sheet)) >= 5, ""),
        ("header bold", bool(re.search(r'<b(?:\s+val="(?:true|1)")?\s*/>', styles)), ""),
    ]


def check_a3(d):
    odt, docx = first(d, ".odt"), first(d, ".docx")
    return [
        ("odt exists", bool(odt), odt),
        ("odt embedded object", any(n.startswith("Object 1/") for n in zip_names(odt)) if odt else False, ""),
        ("docx exists", bool(docx), docx),
        ("docx OLE", any(n.startswith("word/embeddings/") for n in zip_names(docx)) if docx else False, ""),
    ]


def check_a4(d):
    odt, pdf = first(d, ".odt"), first(d, ".pdf")
    names = zip_names(odt) if odt else []
    obj = zip_text(odt, "Object 1/content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("embedded sheet", any(n.startswith("Object 1/") for n in names), ""),
        ("6 rows", len(re.findall(r"<table:table-row", obj)) >= 6, str(len(re.findall(r"<table:table-row", obj)))),
        ("chart", any("Chart" in n for n in names), ""),
        ("pdf exists", bool(pdf) and size_ok(pdf, 5000), pdf),
    ]


def check_a5(d):
    odt = first(d, ".odt")
    names = zip_names(odt) if odt else []
    xml = zip_text(odt, "content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("math object", any("Object" in n for n in names) or "draw:object" in xml, ""),
        ("formula text", "sqrt" in xml or "over" in xml or "Object" in xml, ""),
    ]


def check_a6(d):
    xlsx = first(d, ".xlsx")
    sheet = zip_text(xlsx, "xl/worksheets/sheet1.xml") if xlsx else ""
    styles = zip_text(xlsx, "xl/styles.xml") if xlsx else ""
    return [
        ("xlsx exists", bool(xlsx), xlsx),
        ("freeze pane", "<pane" in sheet, ""),
        ("bold style", bool(re.search(r'<b(?:\s+val="(?:true|1)")?\s*/>', styles)), ""),
        ("column widths", "<cols>" in sheet, ""),
    ]


def check_a8(d):
    odt, docx, pdf = first(d, ".odt"), first(d, ".docx"), first(d, ".pdf")
    return [("odt exists", bool(odt), odt), ("docx exists", bool(docx), docx), ("pdf exists", bool(pdf), pdf)]


def check_a9(_d):
    try:
        with urllib.request.urlopen("http://localhost:8765/health", timeout=3) as r:
            data = json.load(r)
        return [("health green", data.get("status") == "healthy", data.get("commit"))]
    except Exception as e:
        return [("health green", False, str(e))]


def check_a10(d):
    odt = first(d, ".odt")
    names = zip_names(odt) if odt else []
    return [
        ("odt exists", bool(odt), odt),
        ("picture embedded", any(n.startswith("Pictures/") for n in names), ""),
    ]


def check_b1(d):
    odt = first(d, ".odt")
    xml = zip_text(odt, "content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("native table", "<table:table" in xml, ""),
        ("total formula", "ooow:sum" in xml or "sum&lt;" in xml or "of:=" in xml, ""),
    ]


def check_b2(d):
    pdf = first(d, ".pdf")
    text = pdf_text(pdf) if pdf else ""
    landscape = False
    try:
        raw = open(pdf, "rb").read().decode("latin-1", "replace")
        m = re.search(r"MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)", raw)
        landscape = bool(m) and float(m.group(1)) > float(m.group(2))
    except Exception:
        pass
    return [
        ("pdf exists", bool(pdf), pdf),
        ("confidential header", "Confidential" in text, ""),
        ("landscape", landscape, ""),
    ]


def check_b3(d):
    xlsx = first(d, ".xlsx")
    sheet = zip_text(xlsx, "xl/worksheets/sheet1.xml") if xlsx else ""
    styles = zip_text(xlsx, "xl/styles.xml") if xlsx else ""
    return [
        ("xlsx exists", bool(xlsx), xlsx),
        ("merged cells", "<mergeCell" in sheet, ""),
        ("conditional format", "conditionalFormatting" in sheet, ""),
        ("currency format", "currency" in styles.lower() or '"$' in styles, ""),
    ]


def check_b4(d):
    odt = first(d, ".odt")
    xml = zip_text(odt, "content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("bookmark intro", 'text:bookmark' in xml and "intro" in xml, ""),
        ("internal link", 'xlink:href="#intro"' in xml, ""),
        ("external link", "https://" in xml, ""),
    ]


def check_b5(d):
    odt = first(d, ".odt")
    xml = zip_text(odt, "content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("no pending changes", "<text:tracked-changes" not in xml, ""),
    ]


def check_b6(d):
    odt = first(d, ".odt")
    xml = zip_text(odt, "content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("footnote", "<text:note" in xml, ""),
        ("comment", "<office:annotation" in xml, ""),
    ]


def check_b7(d):
    odt = first(d, ".odt")
    xml = zip_text(odt, "content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("table of contents", "text:table-of-content" in xml, ""),
    ]


def check_b8(d):
    xlsx = first(d, ".xlsx")
    names = zip_names(xlsx) if xlsx else []
    return [
        ("xlsx exists", bool(xlsx), xlsx),
        ("pivot object", any("pivot" in n.lower() for n in names), ""),
    ]


def check_b9(d):
    pptx = first(d, ".pptx")
    slides = [n for n in zip_names(pptx) if re.match(r"ppt/slides/slide\d+\.xml$", n)] if pptx else []
    return [("pptx exists", bool(pptx), pptx), ("3 slides", len(slides) == 3, str(len(slides)))]


def check_b10(d):
    pdf = first(d, ".pdf")
    return [("pdf exists", bool(pdf), pdf), ("DRAFT watermark", "DRAFT" in pdf_text(pdf) if pdf else False, "")]


def check_b11(d):
    odt = first(d, ".odt")
    xml = zip_text(odt, "content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("caption sequence", "<text:sequence" in xml, ""),
        ("cross reference", "<text:sequence-ref" in xml, ""),
    ]


def check_b12(d):
    xlsx = first(d, ".xlsx")
    chart = zip_text(xlsx, "xl/charts/chart1.xml") if xlsx else ""
    return [
        ("xlsx exists", bool(xlsx), xlsx),
        ("chart exists", bool(chart), ""),
        ("date axis", "<c:dateAx" in chart or "dateAx" in chart, ""),
    ]


def check_c1(d):
    odt, pdf = first(d, ".odt"), first(d, ".pdf")
    xml = zip_text(odt, "content.xml") if odt else ""
    styles = zip_text(odt, "styles.xml") if odt else ""
    text = pdf_text(pdf) if pdf else ""
    return [
        ("odt exists", bool(odt), odt),
        ("two-column section", 'column-count="2"' in xml, ""),
        ("header text", "Internal" in text, ""),
        ("page-number field", "page-number" in xml or "page-number" in styles, ""),
        ("pdf exists", bool(pdf), pdf),
    ]


def check_c2(d):
    xlsx = first(d, ".xlsx")
    sheet = zip_text(xlsx, "xl/worksheets/sheet1.xml") if xlsx else ""
    styles = zip_text(xlsx, "xl/styles.xml") if xlsx else ""
    return [
        ("xlsx exists", bool(xlsx), xlsx),
        ("merged title", "<mergeCell" in sheet, ""),
        ("SUM formula", bool(re.search(r"<f[^>]*>[^<]*SUM", sheet, re.I)), ""),
        ("currency format", ("numFmt" in styles and ("$" in styles or "currency" in styles.lower())), ""),
        ("frozen header", 'state="frozen"' in sheet, ""),
    ]


def check_c3(d):
    odt = first(d, ".odt")
    xml = zip_text(odt, "content.xml") if odt else ""
    names = zip_names(odt) if odt else []
    return [
        ("odt exists", bool(odt), odt),
        ("native table", "<table:table" in xml, ""),
        ("sum formula", "ooow:sum" in xml or "sum&lt;" in xml, ""),
        ("embedded sheet", any(n.startswith("Object 1/") for n in names), ""),
    ]


def check_c4(d):
    odt, pdf = first(d, ".odt"), first(d, ".pdf")
    xml = zip_text(odt, "content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("bookmark", "text:bookmark" in xml, ""),
        ("internal link", 'xlink:href="#details"' in xml, ""),
        ("footnote", "text:footnote" in xml or "text:note" in xml, ""),
        ("pdf exists", bool(pdf), pdf),
    ]


def check_c5(d):
    pptx = first(d, ".pptx")
    names = zip_names(pptx) if pptx else []
    slides = [n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)]
    notes = [n for n in names if re.match(r"ppt/notesSlides/notesSlide\d+\.xml$", n)]
    notes_text = any(re.search(r"<a:t>[^<]+", zip_text(pptx, n)) for n in notes) if pptx else False
    return [
        ("pptx exists", bool(pptx), pptx),
        ("4 slides", len(slides) >= 4, str(len(slides))),
        ("speaker notes", notes_text, ""),
    ]


def check_c6(d):
    xlsx = first(d, ".xlsx")
    names = zip_names(xlsx) if xlsx else []
    sheet2 = zip_text(xlsx, "xl/worksheets/sheet2.xml") if xlsx else ""
    chart = zip_text(xlsx, "xl/charts/chart1.xml") if xlsx else ""
    return [
        ("xlsx exists", bool(xlsx), xlsx),
        ("two sheets", "xl/worksheets/sheet2.xml" in names, ""),
        ("summary formula", bool(re.search(r'<c r="B2"[^>]*>.*?<f', sheet2, re.S)), ""),
        ("date axis", "<c:dateAx" in chart or "dateAx" in chart, ""),
    ]


def check_d1(d):
    odt = first(d, ".odt")
    xml = zip_text(odt, "content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("numbered list", "list-level-style-number" in xml, ""),
        ("nested list", len(re.findall(r"<text:list[ >]", xml)) >= 2, str(len(re.findall(r"<text:list[ >]", xml)))),
        ("5+ list items", len(re.findall(r"<text:list-item", xml)) >= 5, str(len(re.findall(r"<text:list-item", xml)))),
    ]


def check_d2(d):
    xlsx = first(d, ".xlsx")
    sheet = zip_text(xlsx, "xl/worksheets/sheet1.xml") if xlsx else ""
    wb = zip_text(xlsx, "xl/workbook.xml") if xlsx else ""
    return [
        ("xlsx exists", bool(xlsx), xlsx),
        ("data validation", "<dataValidation" in sheet, ""),
        ("named range", "definedName" in wb and "StatusList" in wb, ""),
    ]


def check_d3(d):
    xlsx = first(d, ".xlsx")
    sheet = zip_text(xlsx, "xl/worksheets/sheet1.xml") if xlsx else ""
    return [
        ("xlsx exists", bool(xlsx), xlsx),
        ("SUMIF formula", bool(re.search(r"<f[^>]*>[^<]*SUMIF", sheet, re.I)), ""),
        ("AutoFilter", "<autoFilter" in sheet, ""),
        ("region totals", len(re.findall(r"SUMIF", sheet, re.I)) >= 2, str(len(re.findall(r"SUMIF", sheet, re.I)))),
    ]


def check_d4(d):
    pptx = first(d, ".pptx")
    names = zip_names(pptx) if pptx else []
    slide2 = zip_text(pptx, "ppt/slides/slide2.xml") if pptx else ""
    media = [n for n in names if n.startswith("ppt/media/")]
    slides = [n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)]
    return [
        ("pptx exists", bool(pptx), pptx),
        ("2 slides", len(slides) >= 2, str(len(slides))),
        ("table", "<a:tbl" in slide2, ""),
        ("image", bool(media), str(len(media))),
    ]


def check_d5(d):
    odt = first(d, ".odt")
    xml = zip_text(odt, "content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("text frame", "<draw:text-box" in xml or "<draw:frame" in xml, ""),
        ("rectangle", "<draw:rect" in xml, ""),
        ("labels", "Sidebar" in xml and "Box" in xml, ""),
    ]


def check_d6(d):
    odt = first(d, ".odt")
    names = zip_names(odt) if odt else []
    inner = zip_text(odt, "Object 1/content.xml") if odt else ""
    return [
        ("odt exists", bool(odt), odt),
        ("embedded writer", "Object 1/" in " ".join(names), ""),
        ("two paragraphs", len(re.findall(r"<text:p", inner)) >= 2, str(len(re.findall(r"<text:p", inner)))),
    ]


def check_d7(d):
    odg = first(d, ".odg")
    pdf = first(d, ".pdf")
    xml = zip_text(odg, "content.xml") if odg else ""
    return [
        ("odg exists", bool(odg), odg),
        ("rectangle", "<draw:rect" in xml, ""),
        ("ellipse", "<draw:ellipse" in xml, ""),
        ("pdf exists", bool(pdf), pdf),
    ]


CHECKS = {
    "A1": check_a1, "A2": check_a2, "A3": check_a3, "A4": check_a4, "A5": check_a5,
    "A6": check_a6, "A8": check_a8, "A9": check_a9, "A10": check_a10,
    "B1": check_b1, "B2": check_b2, "B3": check_b3, "B4": check_b4, "B5": check_b5,
    "B6": check_b6, "B7": check_b7, "B8": check_b8, "B9": check_b9, "B10": check_b10,
    "B11": check_b11, "B12": check_b12,
    "C1": check_c1, "C2": check_c2, "C3": check_c3, "C4": check_c4,
    "C5": check_c5, "C6": check_c6,
    "D1": check_d1, "D2": check_d2, "D3": check_d3, "D4": check_d4,
    "D5": check_d5, "D6": check_d6, "D7": check_d7,
}


def main():
    if len(sys.argv) < 2:
        print("usage: bench_check.py <id> [output_dir]")
        return 2
    pid = sys.argv[1].upper()
    if pid not in CHECKS:
        print(f"{pid}: MANUAL (no mechanical check)")
        return 0
    if len(sys.argv) > 2:
        out = sys.argv[2]
    else:
        prompt = next(p for p in DB["prompts"] if p["id"] == pid)
        out = prompt["output_dir"]
    results = CHECKS[pid](out)
    failed = 0
    for name, ok, detail in results:
        if not ok:
            failed += 1
        print(f"{'PASS' if ok else 'FAIL'}  {pid}  {name}" + (f"  [{detail}]" if detail else ""))
    print(f"{pid}: {'PASS' if failed == 0 else f'FAIL ({failed})'}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

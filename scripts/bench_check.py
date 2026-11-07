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
    pdf = first(d, ".pdf")
    return [("pdf exists", bool(pdf) and size_ok(pdf, 5000), pdf)]


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
        ("bold style", "<b/>" in styles, ""),
        ("column widths", "<cols>" in sheet, ""),
    ]


def check_a8(d):
    docx, pdf = first(d, ".docx"), first(d, ".pdf")
    return [("docx exists", bool(docx), docx), ("pdf exists", bool(pdf), pdf)]


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
        ("total formula", "of:=" in xml and "sum" in xml.lower(), ""),
    ]


def check_b2(d):
    pdf = first(d, ".pdf")
    text = pdf_text(pdf) if pdf else ""
    landscape = False
    try:
        raw = open(pdf, "rb").read(4000).decode("latin-1", "replace")
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


CHECKS = {
    "A1": check_a1, "A2": check_a2, "A3": check_a3, "A4": check_a4, "A5": check_a5,
    "A6": check_a6, "A8": check_a8, "A9": check_a9, "A10": check_a10,
    "B1": check_b1, "B2": check_b2, "B3": check_b3, "B4": check_b4, "B5": check_b5,
    "B6": check_b6, "B7": check_b7, "B8": check_b8, "B9": check_b9, "B10": check_b10,
    "B11": check_b11, "B12": check_b12,
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

// OCR words (image pixels, top-left origin) → text items in PDF space (points,
// baseline y from the bottom) — the same shape pdf-text.js gives native text,
// so lines.js and every extractor work on OCR'd pages unchanged.

/**
 * OCR splits "2,01,743.00" into "2," "01," "743.00" and "713.00" into
 * "713" ".00". Re-join pieces of one number that sit next to each other.
 */
function joinNumberPieces(words) {
  const out = [];
  const byLine = new Map();
  for (const w of words) {
    if (!byLine.has(w.line)) byLine.set(w.line, []);
    byLine.get(w.line).push(w);
  }
  for (const lineWords of byLine.values()) {
    lineWords.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const w of lineWords) {
      const charW = cur ? cur.w / Math.max(cur.t.length, 1) : 0;
      const gap = cur ? w.x - (cur.x + cur.w) : Infinity;
      const continues = cur && gap < 1.6 * charW + 4
        && ((/[\d][,']$/.test(cur.t) && /^\d/.test(w.t)) || (/\d$/.test(cur.t) && /^[.,]\d/.test(w.t)) || (/\d[.]$/.test(cur.t) && /^\d/.test(w.t)));
      if (continues) {
        cur = { ...cur, t: cur.t + w.t, w: w.x + w.w - cur.x, h: Math.max(cur.h, w.h) };
      } else {
        if (cur) out.push(cur);
        cur = { ...w };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * ocr: { width, height, words } for a page rendered at `scale`.
 * nativeItems: the page's own text items — OCR words over them are dropped
 * (real text beats OCR wherever the PDF has it).
 */
function ocrToItems(ocr, { scale, pageHeight, nativeItems = [] }) {
  const boxes = nativeItems.map((it) => ({ x0: it.x - 2, x1: it.x + it.w + 2, y0: it.y - 3, y1: it.y + it.h + 2 }));
  const covered = (x, y) => boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);

  const items = [];
  for (const w of joinNumberPieces(ocr.words)) {
    const x = w.x / scale;
    const width = w.w / scale;
    const h = w.h / scale;
    const baseline = pageHeight - (w.y + w.h) / scale;
    if (covered(x + width / 2, baseline + h / 2)) continue;
    items.push({ str: w.t, x, y: baseline, w: width, h, ocr: true });
  }
  return items;
}

module.exports = { ocrToItems, joinNumberPieces };

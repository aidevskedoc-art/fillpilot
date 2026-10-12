// Positional reading. In real schedules label and value are usually separate
// text items in table cells, so the page is rebuilt as lines (items sharing a
// baseline) split into segments (runs of items with no wide horizontal gap).
// A wide gap = a column break.

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function joinItems(items) {
  let text = '';
  let prevEnd = null;
  for (const it of items) {
    if (prevEnd !== null && !text.endsWith(' ') && !it.str.startsWith(' ') && it.x - prevEnd > 0.8) text += ' ';
    text += it.str;
    prevEnd = it.x + it.w;
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * page: { page, items: [{ str, x, y, w, h }] }
 * returns lines top-to-bottom: { page, index, y, h, segments: [{ text, x0, x1 }], text }
 */
function buildLines(page) {
  const items = [...page.items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    const tol = Math.max(2, 0.3 * Math.min(it.h, row ? row.h : it.h));
    if (row && Math.abs(row.y - it.y) <= tol) {
      row.items.push(it);
    } else {
      rows.push({ y: it.y, h: it.h, items: [it] });
    }
  }

  return rows.map((row, index) => {
    const sorted = row.items.sort((a, b) => a.x - b.x);
    const h = median(sorted.map((it) => it.h)) || 8;
    const columnGap = Math.max(10, 1.1 * h);
    const segments = [];
    let current = [];
    for (const it of sorted) {
      const prev = current[current.length - 1];
      if (prev && it.x - (prev.x + prev.w) > columnGap) {
        segments.push(current);
        current = [];
      }
      current.push(it);
    }
    if (current.length) segments.push(current);

    const segs = segments
      .map((group) => ({
        text: joinItems(group),
        x0: group[0].x,
        x1: group[group.length - 1].x + group[group.length - 1].w,
      }))
      .filter((s) => s.text);

    return { page: page.page, index, y: row.y, h, segments: segs, text: segs.map((s) => s.text).join(' | ') };
  });
}

module.exports = { buildLines };

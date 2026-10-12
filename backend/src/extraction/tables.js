// Basic table detection: a header row of 3+ short label-like cells followed by
// rows whose cells sit under those headers. Multi-line headers and merged
// cells are not understood yet (intelligent tables are Phase 3).

const { isHeaderCell } = require('./label-rules');

const MAX_ROW_GAP_FACTOR = 3; // a gap bigger than 3 line-heights ends the table
const MAX_ROWS = 100;

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Index of the header column a cell belongs to: most horizontal overlap, else nearest centre. */
function columnFor(cell, headers) {
  let best = -1;
  let bestOverlap = 0;
  headers.forEach((h, i) => {
    const o = overlap(cell.x0, cell.x1, h.x0, h.x1);
    if (o > bestOverlap) {
      bestOverlap = o;
      best = i;
    }
  });
  if (best >= 0) return best;
  const centre = (cell.x0 + cell.x1) / 2;
  let nearest = 0;
  headers.forEach((h, i) => {
    const d = Math.abs((h.x0 + h.x1) / 2 - centre);
    if (d < Math.abs((headers[nearest].x0 + headers[nearest].x1) / 2 - centre)) nearest = i;
  });
  return nearest;
}

function isHeaderLine(line) {
  return line.segments.length >= 3 && line.segments.every((s) => isHeaderCell(s.text));
}

/** lines: one page's lines, top to bottom. Returns [{ page, headerIndex, rowIndexes, headers, rows }]. */
function detectTables(lines) {
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    if (!isHeaderLine(header)) continue;

    const rowIndexes = [];
    let prev = header;
    for (let j = i + 1; j < lines.length && rowIndexes.length < MAX_ROWS; j++) {
      const line = lines[j];
      if (prev.y - line.y > MAX_ROW_GAP_FACTOR * Math.max(prev.h, line.h)) break;
      if (line.segments.length < 2 || isHeaderLine(line)) break;
      rowIndexes.push(j);
      prev = line;
    }
    if (rowIndexes.length === 0) continue;

    const headers = header.segments.map((s) => s.text);
    const rows = rowIndexes.map((j) => {
      const cells = headers.map(() => []);
      for (const seg of lines[j].segments) cells[columnFor(seg, header.segments)].push(seg.text);
      return cells.map((c) => c.join(' '));
    });
    tables.push({ page: header.page, headerIndex: i, rowIndexes, headers, rows, headerSegments: header.segments });
    i = rowIndexes[rowIndexes.length - 1];
  }
  return tables;
}

module.exports = { detectTables, columnFor };

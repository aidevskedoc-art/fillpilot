// Rule-based key-value extraction over positional lines. Rules, strongest first:
//   inline        "POLICY NO.: 0503…" / "Invoice # HSG-…" inside one segment     0.95 / 0.85
//   colon-next    "Agent Name" | ": PUSHPALATHA"  or  "Mobile :" | "98765…"         0.90
//   segment-pair  "Policy Number" | "0503…"  (2-segment lines, or a known label)  0.85
//   header-row    labels row over a single values row (HDFC intermediary block)  0.80
//   label-below   "Communication Address:" then the value on the next line(s)    0.75
//   label-above   a known label alone on a line, value centred below it          0.70
//                 (UIIC "Policyholder" / "MR RAJESH …")
//   qualifier     "Period Of Insurance" | "From" | "<date>" | "To" | "<date>"    0.85
//                 → "Period Of Insurance From", "Period Of Insurance To"
// Lines inside a detected multi-row table are left to tables.js — pairing a
// data row's cells with each other produces junk like "Self: Salaried".

const { cleanLabel, cleanValue, isLabelText, isHeaderCell, isValueText, splitInline } = require('./label-rules');
const { detectTables, columnFor } = require('./tables');
const { normLabel } = require('../text/labels');

const QUALIFIERS = new Map([['from', 'From'], ['to', 'To'], ['t o', 'To'], ['till', 'Till'], ['upto', 'Upto'], ['up to', 'Upto']]);
// A "value" that is itself a column heading ("Development Officer Code", "Nominee", "SI(Rs.)").
const HEADING_WORD = /\b(name|code|no|number|date|id|address|relation|type|amount)\.?$|\((rs|inr|₹|`|%)\.?\)$/i;

/** Pages where most lines are sentences are policy wording; their pairs count for less. */
const PROSE_LINE_WORDS = 10;
const PROSE_PAGE_RATIO = 0.5;
const PROSE_PENALTY = 0.85;
/** Bottom 10% / top 6% of the page (PDF y grows upwards). */
const FOOTER_ZONE = 0.1;
const HEADER_ZONE = 0.94;
const EDGE_PENALTY = 0.8;
const ADDRESS_LINES = 6;

function bboxOf(line, seg) {
  return { page: line.page, x0: Math.round(seg.x0), x1: Math.round(seg.x1), y: Math.round(line.y) };
}

/**
 * lines: all lines of one page (buildLines output).
 * isKnownLabel(text): true when the label is in the alias dictionary — extra
 * evidence that lets a pair be taken from a busy multi-segment line.
 */
function extractPage(lines, { isKnownLabel = () => false, pageHeight = 0 } = {}) {
  const out = [];
  const consumed = new Set();
  const proseLines = lines.filter((l) => l.segments.length === 1 && l.text.split(/\s+/).length >= PROSE_LINE_WORDS).length;
  const pagePenalty = lines.length && proseLines / lines.length > PROSE_PAGE_RATIO ? PROSE_PENALTY : 1;
  // Running headers/footers hold the insurer's own office, email and phone —
  // boilerplate that must not outrank the customer's details in the body.
  const zonePenalty = (line) =>
    pageHeight && (line.y < pageHeight * FOOTER_ZONE || line.y > pageHeight * HEADER_ZONE) ? EDGE_PENALTY : 1;

  const push = (label, value, confidence, method, line, seg) => {
    let l = cleanLabel(label);
    let v = cleanValue(value);
    // "Period of Insurance" | "From : 11-Jun-2026" → "Period of Insurance From" = "11-Jun-2026"
    const q = /^(from|to|till|upto|valid from|valid till)\s*[:\-–]?\s*(.*\d.*)$/i.exec(v);
    if (q) {
      l = `${l} ${QUALIFIERS.get(q[1].toLowerCase()) || q[1]}`;
      v = cleanValue(q[2]);
    }
    if (!l || !isValueText(v)) return false;
    const known = isKnownLabel(l);
    // Real labels are Title Case or UPPER. Lowercase "that" / "insurance company: will not
    // pay any…" is a sentence broken at a colon or line end — even when the words are a known label.
    if (!/^[A-Z]/.test(l)) return false;
    if (/^[a-z]/.test(v) && v.split(/\s+/).length >= 3) return false;
    // The "value" is another heading, not data.
    if (normLabel(v) === normLabel(l)) return false;
    if (isHeaderCell(v) && (isKnownLabel(v) || HEADING_WORD.test(v))) return false;
    // A person's name split across two columns ("PABBISETTY" | "BHARGAVASAI").
    if (!known && /^[A-Z]+$/.test(l) && /^[A-Z][A-Z .,]*$/.test(v)) return false;
    const conf = confidence * pagePenalty * zonePenalty(line);
    out.push({ label: l, value: v, confidence: Number(conf.toFixed(3)), method, page: line.page, bbox: bboxOf(line, seg), order: line.index });
    return true;
  };

  // Tables first. One data row under a header row is a form block (labels over
  // values) → key-value pairs. In a multi-row table, rows are still scanned but
  // treated as busy lines: only strong evidence (separator, known label,
  // From/To qualifier) makes a pair — real schedules mix key-value rows
  // ("Policy Type | Individual Basis") into what detection calls a table.
  const tables = detectTables(lines);
  const tableRows = new Set();
  for (const t of tables) {
    consumed.add(t.headerIndex);
    if (t.rowIndexes.length === 1) {
      const row = lines[t.rowIndexes[0]];
      consumed.add(t.rowIndexes[0]);
      const values = t.headers.map(() => []);
      for (const seg of row.segments) values[columnFor(seg, t.headerSegments)].push(seg.text);
      t.headerSegments.forEach((h, c) => push(h.text, values[c].join(' '), 0.8, 'header-row', row, h));
    } else {
      for (const idx of t.rowIndexes) tableRows.add(idx);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    const line = lines[i];
    const segs = line.segments;
    const busy = segs.length >= 3 || tableRows.has(i);
    let lineLabel = null; // last plain label on this line, for "From"/"To" qualifiers

    if (segs.length === 1 && isKnownLabel(segs[0].text) && !splitInline(segs[0].text)) {
      if (labelAbove(lines, i, consumed, push, isKnownLabel)) continue;
    }

    for (let j = 0; j < segs.length; j++) {
      const seg = segs[j];
      const next = segs[j + 1];
      const inline = splitInline(seg.text);

      const qualifier = QUALIFIERS.get(normLabel(seg.text));
      if (qualifier && next && /\d/.test(next.text) && !splitInline(next.text)) {
        push(lineLabel ? `${lineLabel} ${qualifier}` : qualifier, next.text, 0.85, 'qualifier', line, seg);
        j++;
        continue;
      }
      if (!inline && isLabelText(seg.text)) lineLabel = cleanLabel(seg.text);

      if (inline && inline.value) {
        push(inline.label, inline.value, inline.sep === ':' ? 0.95 : 0.85, 'inline', line, seg);
        continue;
      }

      if (inline && !inline.value) {
        // "Label :" — value in the next segment, or on the line(s) below.
        if (next && isValueText(next.text) && !splitInline(next.text)) {
          push(inline.label, next.text, 0.9, 'colon-next', line, seg);
          j++;
          continue;
        }
        if (segs.length === 1) {
          const value = valueBelow(lines, i, seg, inline.label, consumed);
          if (value) push(inline.label, value, 0.75, 'label-below', line, seg);
        }
        continue;
      }

      if (!next || !isLabelText(seg.text)) continue;

      if (/^\s*[:#]/.test(next.text)) {
        push(seg.text, next.text, 0.9, 'colon-next', line, seg);
        j++;
        continue;
      }

      const nextInline = splitInline(next.text);
      if (nextInline || !isValueText(next.text)) continue;
      if (QUALIFIERS.has(normLabel(next.text))) continue;
      if (busy && !isKnownLabel(seg.text)) continue;
      if (push(seg.text, next.text, 0.85, 'segment-pair', line, seg)) j++;
    }
  }

  return { pairs: out, tables };
}

/** A known label alone on its line with a short single-segment value directly below. */
function labelAbove(lines, i, consumed, push, isKnownLabel) {
  const line = lines[i];
  const below = lines[i + 1];
  if (!below || consumed.has(i + 1) || below.segments.length !== 1) return false;
  if (line.y - below.y > 2.2 * Math.max(line.h, below.h)) return false;
  const text = below.segments[0].text;
  if (splitInline(text) || isKnownLabel(text) || text.split(/\s+/).length > 8) return false;
  if (!push(line.segments[0].text, text, 0.7, 'label-above', line, line.segments[0])) return false;
  consumed.add(i + 1);
  return true;
}

/** Value lines under a "Label:" line, starting near the label's x. Addresses may span several lines. */
function valueBelow(lines, labelIndex, labelSeg, label, consumed) {
  const maxLines = /address/i.test(label) ? ADDRESS_LINES : 1;
  const parts = [];
  let prev = lines[labelIndex];
  for (let k = labelIndex + 1; k < lines.length && parts.length < maxLines; k++) {
    const line = lines[k];
    if (consumed.has(k)) break;
    if (prev.y - line.y > 2.2 * Math.max(prev.h, line.h)) break;
    if (line.segments.length !== 1) break;
    const seg = line.segments[0];
    if (Math.abs(seg.x0 - labelSeg.x0) > 20) break;
    if (splitInline(seg.text)) break;
    // "i. medical treatment…" / "a. Having at least…" — a list in policy wording, not a value.
    if (/^(\(?[ivx]+[.)]|[a-z][.)]|\d{1,2}[.)])\s/i.test(seg.text)) break;
    if (/^[\s\-–,.]+$/.test(seg.text)) {
      consumed.add(k);
      prev = line;
      continue;
    }
    parts.push(seg.text);
    consumed.add(k);
    prev = line;
  }
  return parts.join(', ');
}

module.exports = { extractPage };

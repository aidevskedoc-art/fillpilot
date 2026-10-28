// Yashoda Healthcare bills → structured data, with the bill's own arithmetic
// used to catch OCR misreads.
//
//   final bill    "Description | Value | Charged Amount" table: numbered
//                 sections, optional sub-groups, items (qty × rate, tariff
//                 code, amount), "Sub Total..." per group, Grand Total, Net Amount.
//   summary bill  header (name, IP no, consultant, company, D.O.A/D.O.D,
//                 invoice no) + one amount per group + credit / paid / total.
//
// Both are printed as images, so most of the text comes from OCR (see
// extraction/pdf-text.js). Every amount is checked: qty × rate = amount,
// items = sub total, sub totals = grand total, and credit + paid = total.

const { isoIfValid } = require('../normalize');

// ---------------------------------------------------------------- helpers

/** OCR look-alikes in a place that holds only digits: I l L i | ! → 1, O o → 0. */
function toDigits(text) {
  return String(text).replace(/[IlLi|!]/g, '1').replace(/[Oo]/g, '0');
}

/** Amounts are digits only, so every look-alike inside one is a digit. */
function parseAmount(text) {
  if (!text) return null;
  const s = toDigits(text)
    .replace(/[\s'`]/g, '')
    .replace(/[^\d.,]/g, '');
  const m = /^(\d{1,3}(?:,\d{2,3})*|\d+)\.(\d{2})$/.exec(s);
  return m ? Number(`${m[1].replace(/,/g, '')}.${m[2]}`) : null;
}

/**
 * A number printed as digits only (IP no, YH no, age): "I31885" → 131885.
 * Left as read when it does not become a number — a mismatch then shows.
 */
function repairNumber(text) {
  if (text == null) return text;
  const read = String(text).trim();
  const fixed = toDigits(read);
  return /^\d+$/.test(fixed) ? fixed : read;
}

/**
 * A person's name has no digits: a 1 (or | !) or a 0 next to a letter is the
 * letter I or O — "NET1" → NETI, "R0Y" → ROY. A digit standing alone is left.
 */
function repairName(text) {
  if (!text) return text;
  return text
    .replace(/(?<=[A-Za-z])[1|!]|[1|!](?=[A-Za-z])/g, 'I')
    .replace(/(?<=[A-Za-z])0|0(?=[A-Za-z])/g, 'O');
}

const round2 = (n) => Math.round(n * 100) / 100;
const sameAmount = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;
const sum = (list) => round2(list.reduce((s, n) => s + (n || 0), 0));

/**
 * Yashoda's own item codes — not a payer's tariff or package code. They are
 * printed as they are (no digits), so they would otherwise look misread.
 * A payer site takes them as the hospital's own items (CIL: Unlisted Procedures).
 */
const OWN_CODES = new Set(['YSSH']);

/**
 * Item code as printed — a tariff code ("41A/NIMS", "78I/NIMS", "2121/COMM.",
 * "NIMS/11E", "R171+171/NIMS", "S5.1.17") or a package code ("CI011", "LB037") —
 * repaired from OCR ("IIA/NIMS", "RI 71/NIMS", "75 IA/NIMS", "303/cou.", "CIOII").
 *
 * OCR confuses I with 1 and O with 0 both ways, so each character is read by
 * its place in the code's shape, never by a blanket swap:
 *   tariff code (NIMS / COMM)   [up to 2 letters][digits][maybe 1 letter]
 *   package code (PM-JAY, CIL)  2 letters + 3 digits
 * A code without a NIMS / COMM mark is read by `family` — the kind of codes the
 * rest of its bill carries (see codeFamily): 'package' (the default) or 'nims'.
 * On a NIMS bill an unmarked code printed with two letters first is still a
 * package code — the CGHS codes some lines carry (MG038, CI001, LB012); read as
 * a tariff code, CI001 would become C1001. Printed with a digit there (N1003),
 * it stays a tariff code.
 *
 * → { code, tariff: 'NIMS' | 'COMM' | null, raw, valid, own?, alternatives? }
 *   alternatives: other readings where the shape cannot settle I against 1
 *   (78I / 781) — the site's tariff list does.
 */
function normalizeCode(raw, family = 'package') {
  if (!raw || !raw.trim()) return null;
  const own = raw.replace(/\s+/g, '').toUpperCase();
  if (OWN_CODES.has(own)) return { code: own, tariff: null, raw: raw.trim(), valid: true, own: true };
  // The bills print codes in capitals; a | or ! is OCR's 1 or I (read by place in the fixers below).
  const parts = raw.replace(/\s+/g, '').toUpperCase().split('/').filter(Boolean);
  let tariff = null;
  const codeParts = [];
  parts.forEach((part, i) => {
    if (/^N[I1L|!]M[S5]\.?$/.test(part)) tariff = 'NIMS';
    // "COMM." after the slash, as OCR mangles it: COPN. CORM. COU. CONUN. C02Q.F CO»N.F
    else if (i > 0 && /^C[O0][^/]{0,5}$/.test(part) && !/^C[O0]\d+$/.test(part)) tariff = 'COMM';
    else codeParts.push(part);
  });
  const asPackage = (p) => !tariff && (family !== 'nims' || /^[A-Z]{2}[\dILO|!]{3}$/.test(p));
  const read = codeParts.map((p) => (asPackage(p) ? { code: fixPackageCode(p), alternatives: [] } : fixTariffCode(p)));
  const code = read.map((r) => r.code).join('/');
  const alternatives = read.length === 1 ? read[0].alternatives : [];
  const single = '[A-Z]{0,3}\\d+[A-Z]?';
  const valid = new RegExp(`^${single}(\\+${single})*$`).test(code) || /^[A-Z]\d+(\.\d+)+$/.test(code);
  return { code, tariff, raw: raw.trim(), valid: Boolean(code) && valid, ...(alternatives.length ? { alternatives } : {}) };
}

/** A tariff code, several joined by "+" ("R171+171", "N1003+14A") → { code, alternatives }. */
function fixTariffCode(part) {
  const pieces = part.split('+').map(fixTariffPiece);
  return { code: pieces.map((p) => p.code).join('+'), alternatives: pieces.length === 1 ? pieces[0].alternatives : [] };
}

/**
 * One tariff code: up to two letters, digits, maybe one letter ("R171", "RH41",
 * "N1003", "41A", "78I"), or a surgery code ("S5.1.17").
 * - In the digits, I and L are OCR's 1 and O its 0: "IIA" → 11A, "RI71" → R171,
 *   "75IA" → 751A, "4OA" → 40A, "1O96" → 1096. The first letters are never I or
 *   L — those are 1s.
 * - The last place after the digits holds either a digit or the code's own letter
 *   (78I). When OCR read a look-alike there (I, L, | or !), the code follows it —
 *   an I after digits stays I, the others are 1 — and the other reading is
 *   returned as an alternative.
 * - A clean 1 there is kept as 1, but OCR also reads the letter I as a clean 1
 *   (TSH 78I came out as 781 on a client's bill, 2026-10-22). Where a NIMS letter
 *   can stand — 2 or 3 digits, no prefix (41A, 751A, 78I) — the I is returned as
 *   the other reading; the site's list and price decide.
 */
function fixTariffPiece(piece) {
  const surgery = /^([A-Z])([\dILO|!]+(?:\.[\dILO|!]+)+)$/.exec(piece);
  if (surgery) return { code: surgery[1] + toDigits(surgery[2]), alternatives: [] };
  const m = /^([A-HJ-KM-Z]{0,2})([\dILO|!]+)([A-Z]?)$/.exec(piece);
  // Too little to tell digits from letters ("IA"): left as read (and flagged as not a code).
  if (!m || (!/\d/.test(m[2]) && m[2].length < 2)) return { code: piece, alternatives: [] };
  const [, prefix, run, letter] = m;
  const digits = toDigits(run);
  if (letter || digits.length < 2) return { code: prefix + digits + letter, alternatives: [] };
  const asOne = prefix + digits;
  const asI = `${prefix}${digits.slice(0, -1)}I`;
  if (!/[IL|!]$/.test(run)) {
    const couldBeI = !prefix && run.endsWith('1') && /^\d{3,4}$/.test(digits);
    return { code: asOne, alternatives: couldBeI ? [asI] : [] };
  }
  return run.endsWith('I') && /\d/.test(run.slice(0, -1))
    ? { code: asI, alternatives: [asOne] }
    : { code: asOne, alternatives: [asI] };
}

/**
 * A package code (PM-JAY, Coal India) as OCR reads it → two letters + three
 * digits: "CIOII" → "CI011", "LBIOO" → "LB100", "C1001" → "CI001". Anything that
 * does not become that shape is left as read (and flagged if it is not a code).
 */
function fixPackageCode(read) {
  const part = read.replace(/[|!]/g, '1');
  if (part.length !== 5) return read;
  const fixed = part.slice(0, 2).replace(/1/g, 'I').replace(/0/g, 'O') + toDigits(part.slice(2));
  return /^[A-Z]{2}\d{3}$/.test(fixed) ? fixed : read;
}

/**
 * Which kind of codes a final bill carries: NIMS / COMM-marked tariff codes (a
 * TGNPDCL patient) or unmarked package codes (PM-JAY, Coal India). A code printed
 * without a mark is read the same way as the rest: "N1003" stays N1003 on a NIMS
 * bill, while "C1001" is CI001 on a package bill.
 */
function codeFamily(rawCodes) {
  let marked = 0;
  let packaged = 0;
  for (const raw of rawCodes) {
    const c = normalizeCode(raw);
    if (!c || c.own) continue;
    if (c.tariff) marked += 1;
    else if (/^[A-Z]{2}\d{3}$/.test(c.code)) packaged += 1;
  }
  return marked > packaged ? 'nims' : 'package';
}

/** "2 Visit(s) x 350.00", "1 Time ( s ) x 75.00", "2 X 450.00" → { qty, unit, rate } */
function parseQuantity(text) {
  const t = text || '';
  const m = /(\d+)\s*([A-Za-z]+)\s*\(\s*s\s*\)\s*(?:[xX×]\s*([\dIlOo,.]+))?/.exec(t)
    || /(\d+)()\s*[xX×]\s*([\dIlOo,.]+)/.exec(t);
  if (!m) return {};
  return { qty: Number(m[1]), unit: m[2] || null, rate: m[3] ? parseAmount(m[3]) : null };
}

const isPunctuationOnly = (text) => /^[\s\-–.,:;'"`_|]*$/.test(text);

// ------------------------------------------------------------- detection

function detectFormat(allLines) {
  const text = allLines.map((l) => l.text).join('\n');
  if (!/YASHODA/i.test(text)) return null;
  if (/BILL OF SUPPLY/i.test(text) && /INVOICE\s*NO/i.test(text)) return 'yashoda-summary-bill';
  if (/Charged\s+Amount/i.test(text) && /Sub\s*Total/i.test(text)) return 'yashoda-final-bill';
  return null;
}

// ------------------------------------------------------------ final bill

/**
 * Column boundaries as a share of page width. Codes start at 0.656 on some
 * bills (a 3-page TGNPDCL bill, 2026-09) and at 0.66–0.76 on others, so the
 * code column begins at 0.62: quantities are left-aligned at about 0.39, and the
 * right-aligned "Sub Total..." / "Grand Total..." / "Net Amount :" end before
 * the codes.
 */
const FINAL_COLUMNS = { value: 0.4, code: 0.62, amount: 0.82 };
/** Numbered section headings sit at the left margin. */
const SECTION_MAX_X = 25;
/**
 * Sub-group headings ("HAEMATOLOGY") are indented less than items, but the
 * absolute indent differs between bills (44pt vs 48pt for items), so it is
 * measured per page from the item lines.
 */
const GROUP_INDENT_GAP = 2.5;
/** Text far right of the item column is the hospital stamp / signature, not the bill. */
const STAMP_INDENT_GAP = 30;
const STAMP_TEXT = /YASHODA\s+HOSPITAL|HEALTH\s*CARE\s+SERVICES\s+LTD|Survey\s*No|Hyderabad\s*-?\s*500/i;
const DEFAULT_ITEM_INDENT = 47;

function columns(line, width) {
  const cols = { desc: [], value: [], code: [], amount: [] };
  for (const seg of line.segments) {
    const f = seg.x0 / width;
    if (f >= FINAL_COLUMNS.amount) cols.amount.push(seg);
    else if (f >= FINAL_COLUMNS.code) cols.code.push(seg);
    else if (f >= FINAL_COLUMNS.value) cols.value.push(seg);
    else cols.desc.push(seg);
  }
  const text = (segs) => segs.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  return {
    desc: text(cols.desc),
    descX: cols.desc[0]?.x0 ?? null,
    value: text(cols.value),
    code: text(cols.code),
    amount: text(cols.amount),
  };
}

/** OCR reads the header's "Name :" as "Name ." or "Name ;" too. */
const NAME_LABEL = 'Name\\s*[:.;]';

function isHeaderLine(text) {
  return /YASHODA\s+HEALTHCARE/i.test(text) || new RegExp(`^${NAME_LABEL}`, 'i').test(text) || (/^Description\b/i.test(text) && /Charged/i.test(text)) || /^Page\s+\d+\s+of\s+\d+$/i.test(text);
}

/** Median x of item descriptions on a page (lines that carry an amount). */
function itemIndentOf(lines, width) {
  const xs = lines
    .map((l) => columns(l, width))
    .filter((c) => c.amount && c.desc && c.descX != null && c.descX >= SECTION_MAX_X)
    .map((c) => c.descX)
    .sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : null;
}

/**
 * pages: [{ page, width, lines }] → structured final bill.
 */
function parseFinalBill(pages) {
  const issues = [];
  const patient = {};
  const sections = [];
  let section = null;
  let group = null;
  let grandTotal = null;
  let netAmount = null;

  const newGroup = (name) => {
    if (!section) {
      section = { no: null, name: 'Unnumbered', groups: [] };
      sections.push(section);
    }
    group = { name, rows: [], subTotal: null, subTotalRaw: null };
    section.groups.push(group);
    return group;
  };

  let itemIndent = DEFAULT_ITEM_INDENT;
  for (const { page, width, lines } of pages) {
    itemIndent = itemIndentOf(lines, width) ?? itemIndent;
    for (const line of lines) {
      const text = line.text.replace(/\s*\|\s*/g, ' ').trim();
      // "IP No" as OCR reads it too ("1P N0"); the IP number is digits only ("I31885" → 131885).
      const nameMatch = new RegExp(`^${NAME_LABEL}\\s*(.+?)\\s+[I1l|]P\\s*N[o0]\\s*[:.;]?\\s*([\\dIlLO|!]+)`, 'i').exec(text);
      if (nameMatch) {
        patient.name ||= repairName(nameMatch[1].trim());
        patient.ipNo ||= repairNumber(nameMatch[2]);
        continue;
      }
      if (isHeaderLine(text) || isPunctuationOnly(text) || STAMP_TEXT.test(text)) continue;

      const c = columns(line, width);
      if (!c.amount && c.descX != null && c.descX > itemIndent + STAMP_INDENT_GAP) continue; // stamp / signature
      const pos = page * 100000 + (100000 - line.y * 100); // reading order across pages

      if ([c.value, c.desc, c.code].some((t) => /sub\s*total/i.test(t))) {
        if (!group) newGroup(null);
        group.subTotal = parseAmount(c.amount);
        group.subTotalRaw = c.amount || null;
        group.closed = true;
        continue;
      }
      if (/grand\s*total/i.test(text)) {
        grandTotal = parseAmount(c.amount);
        continue;
      }
      if (/^net\b/i.test(c.value) || /^net\s+amount/i.test(text)) {
        netAmount = parseAmount(c.amount);
        continue;
      }

      const sectionMatch = /^(\d{1,2})\s*\.?\s+(.+)$/.exec(c.desc);
      if (sectionMatch && c.descX != null && c.descX < SECTION_MAX_X && !c.amount && !c.code) {
        section = { no: Number(sectionMatch[1]), name: sectionMatch[2].trim(), groups: [] };
        sections.push(section);
        group = null;
        continue;
      }
      // A sub-group heading only ever follows a section heading or a "Sub Total"
      // — so the second line of a description ("MONITORING)") can't become one.
      const groupOpen = group && !group.closed;
      if (c.desc && !c.amount && !c.code && !c.value && c.descX != null && c.descX < itemIndent - GROUP_INDENT_GAP && !groupOpen) {
        newGroup(c.desc);
        continue;
      }

      if (!group || group.closed) newGroup(group?.closed ? null : section?.name ?? null);
      if (c.amount) {
        group.rows.push({ kind: 'anchor', pos, page, desc: c.desc, value: c.value, code: c.code, amount: c.amount });
      } else if (c.desc) {
        group.rows.push({ kind: 'text', pos, page, desc: c.desc });
      }
    }
  }

  // Codes printed without a NIMS / COMM mark are read like the rest of this bill's codes.
  const family = codeFamily(sections.flatMap((s) => s.groups.flatMap((g) => g.rows.filter((r) => r.kind === 'anchor' && r.code).map((r) => r.code))));

  // Rows → items: description lines join the nearest amount line of their group
  // (multi-line descriptions are printed centred on the amount).
  let computedTotal = 0;
  for (const s of sections) {
    // Doctor lines are names, which hold no digits.
    const names = /DOCTOR|CONSULTATION/i.test(s.name);
    for (const g of s.groups) {
      const anchors = g.rows.filter((r) => r.kind === 'anchor').map((r) => ({ ...r, parts: r.desc ? [{ pos: r.pos, text: r.desc }] : [] }));
      for (const t of g.rows.filter((r) => r.kind === 'text')) {
        if (!anchors.length) continue;
        // "CHLORIDE)" / "MONITORING)" close a bracket opened above — they end the item above.
        const closesBracket = (t.desc.match(/\)/g) || []).length > (t.desc.match(/\(/g) || []).length;
        const above = anchors.filter((a) => a.pos < t.pos).pop();
        const nearest = closesBracket && above
          ? above
          : anchors.reduce((best, a) => (Math.abs(a.pos - t.pos) < Math.abs(best.pos - t.pos) ? a : best));
        nearest.parts.push({ pos: t.pos, text: t.desc });
      }
      g.items = anchors.map((a) => {
        let q = parseQuantity(a.value);
        // "2O Time(s) X 40.00": OCR spoilt the count, which would quietly become 1.
        // Count × rate is the amount, so the count is amount ÷ rate when that is whole.
        let qtyNote = null;
        if (q.qty == null && a.value && /\d|\(\s*s\s*\)|[xX×]\s*[\dIlOo]/.test(a.value)) {
          const rate = parseAmount(/[xX×]\s*([\dIlOo,.\s]+)$/.exec(a.value)?.[1]);
          const charged = parseAmount(a.amount);
          const count = rate && charged != null ? round2(charged / rate) : null;
          if (count && Number.isInteger(count)) {
            q = { qty: count, unit: null, rate };
            qtyNote = `Quantity "${a.value}" unreadable — worked out as amount ÷ rate = ${count}`;
          } else {
            qtyNote = `Quantity "${a.value}" could not be read — 1 assumed`;
          }
        }
        const code = normalizeCode(a.code, family);
        const description = a.parts.sort((x, y) => x.pos - y.pos).map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim();
        const item = {
          description: names ? repairName(description) : description,
          qty: q.qty ?? 1,
          unit: q.unit ?? null,
          rate: q.rate ?? null,
          code: code?.code ?? null,
          tariff: code?.tariff ?? null,
          codeRaw: code?.raw ?? null,
          amount: parseAmount(a.amount),
          amountRaw: a.amount || null,
          page: a.page,
          issues: [],
          ...(code?.own ? { ownCode: true } : {}),
          ...(code?.alternatives ? { codeAlternatives: code.alternatives } : {}),
        };
        if (qtyNote) item.issues.push(qtyNote);
        if (code && !code.valid) item.issues.push(`Code "${code.raw}" may be misread`);
        if (item.amount == null) item.issues.push(`Amount "${a.amount || ''}" could not be read`);
        if (item.amount != null && item.rate != null && q.qty && !sameAmount(round2(q.qty * item.rate), item.amount)) {
          item.issues.push(`${q.qty} × ${item.rate} = ${round2(q.qty * item.rate)}, but the amount reads ${item.amount}`);
        }
        return item;
      });
      delete g.rows;
      delete g.closed;
      reconcileGroup(s, g, issues);
      computedTotal += g.subTotal ?? sum(g.items.map((i) => i.amount));
    }
  }
  computedTotal = round2(computedTotal);

  if (grandTotal == null) {
    issues.push({ level: 'info', message: `Grand total not readable — using the sum of the sections, ${computedTotal.toFixed(2)}` });
    grandTotal = computedTotal;
  } else if (!sameAmount(grandTotal, computedTotal)) {
    const gap = round2(grandTotal - computedTotal);
    // 4,01,645.90 read as 645.90: OCR dropped the leading digits, so the gap is a round number.
    const hint = gap > 0 && gap % 1000 === 0 ? ` — the difference ${gap.toFixed(2)} is a round number: a large amount probably lost its first digits in reading` : '';
    issues.push({ level: 'error', message: `Sections add up to ${computedTotal.toFixed(2)} but the grand total reads ${grandTotal.toFixed(2)}${hint}` });
  }
  if (netAmount != null && Math.abs(Math.round(grandTotal) - netAmount) > 1) {
    issues.push({ level: 'error', message: `Net amount ${netAmount.toFixed(2)} does not match the grand total ${grandTotal.toFixed(2)}` });
  }
  if (!patient.ipNo) issues.push({ level: 'error', message: 'IP number not found on the bill' });

  for (const s of sections) {
    for (const g of s.groups) {
      for (const it of g.items) {
        for (const message of it.issues) issues.push({ level: 'warning', message: `${it.description || g.name}: ${message}` });
      }
    }
  }

  const doctorSection = sections.find((s) => /DOCTOR/i.test(s.name));
  const doctors = doctorSection
    ? doctorSection.groups.flatMap((g) => g.items).map((i) => ({ name: i.description, visits: i.qty, rate: i.rate, amount: i.amount }))
    : [];

  return {
    format: 'yashoda-final-bill',
    patient,
    sections,
    doctors,
    totals: { computed: computedTotal, grandTotal, netAmount },
    issues,
  };
}

/**
 * Items vs. "Sub Total...". When exactly one figure is unreadable it is
 * derived from the others (marked corrected); a disagreement between readable
 * figures is reported, never silently "fixed".
 */
function reconcileGroup(section, g, issues) {
  const where = g.name || section.name;
  const known = g.items.filter((i) => i.amount != null);
  const missing = g.items.filter((i) => i.amount == null);
  const itemsSum = sum(known.map((i) => i.amount));

  if (g.subTotal == null && missing.length === 0) {
    if (g.subTotalRaw) issues.push({ level: 'info', message: `${where}: sub total "${g.subTotalRaw}" unreadable — using the items' sum ${itemsSum.toFixed(2)}` });
    g.subTotal = itemsSum;
    return;
  }
  if (g.subTotal != null && missing.length === 1) {
    const derived = round2(g.subTotal - itemsSum);
    const item = missing[0];
    item.amount = derived;
    item.corrected = true;
    item.issues = item.issues.filter((m) => !/could not be read/.test(m));
    item.issues.push(`Amount derived from the sub total: ${derived.toFixed(2)}`);
    return;
  }
  if (g.subTotal != null && missing.length === 0 && !sameAmount(itemsSum, g.subTotal)) {
    // One item with qty × rate disagreeing with its own amount → trust qty × rate if that makes the group add up.
    for (const it of g.items) {
      if (it.rate != null && it.qty) {
        const expected = round2(it.qty * it.rate);
        if (!sameAmount(expected, it.amount) && sameAmount(round2(itemsSum - it.amount + expected), g.subTotal)) {
          it.issues.push(`Amount corrected from ${it.amount} to ${expected} (qty × rate and the sub total agree)`);
          it.amount = expected;
          it.corrected = true;
          return;
        }
      }
    }
    // The sub total itself misread ("21,000.00" → "000.00"): fewer digits than the
    // items' sum, or every item checks out as qty × rate. The grand total and the
    // summary bill still cross-check this group.
    const digits = (s) => (String(s).match(/\d/g) || []).length;
    const verified = g.items.length > 0 && g.items.every((i) => i.rate != null && sameAmount(round2(i.qty * i.rate), i.amount));
    if (digits(g.subTotalRaw) < digits(itemsSum.toFixed(2)) || verified) {
      issues.push({ level: 'info', message: `${where}: sub total read as "${g.subTotalRaw}" — using the items' sum ${itemsSum.toFixed(2)}` });
      g.subTotal = itemsSum;
      return;
    }
    issues.push({ level: 'error', message: `${where}: items add up to ${itemsSum.toFixed(2)} but the sub total reads ${g.subTotal.toFixed(2)}` });
    return;
  }
  if (missing.length > 1) {
    issues.push({ level: 'error', message: `${where}: ${missing.length} amounts could not be read` });
  }
}

// ---------------------------------------------------------- summary bill

/**
 * Invoice numbers are "ICO" + 7 digits. OCR reads the letters as digits
 * ("IC06076856", "1CO6076856") and the digits as letters ("ICO6O7I879"); each
 * place is put back to what it holds. Anything else is left as read.
 */
function repairInvoiceNo(text) {
  const read = String(text).toUpperCase();
  const m = /^[I1L|!]C[O0](.{7})$/.exec(read);
  if (!m) return read;
  const digits = toDigits(m[1]);
  return /^\d{7}$/.test(digits) ? `ICO${digits}` : read;
}

/** "10-10-2026 01:36" — digits only, so look-alikes are digits ("1O-1O-2026"). */
function parseDateTime(text) {
  const m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\s+(\d{1,2}:\d{2}))?/.exec(toDigits(text || ''));
  if (!m) return null;
  return { date: isoIfValid(m[3], m[2], m[1]), time: m[4] || null };
}

/**
 * The summary bill prints its totals' amounts in bold, a little lower than
 * their labels, so "PAID AMOUNT :" and "70,000.00" land on separate lines.
 * An amount-only line joins the label-only line right next to it.
 */
function attachAmountLines(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const amountOnly = line.segments.length === 1 && parseAmount(line.segments[0].text) != null;
    const prevHasAmount = prev && parseAmount(prev.segments[prev.segments.length - 1].text) != null;
    if (amountOnly && prev && !prevHasAmount && Math.abs(prev.y - line.y) <= 0.6 * Math.max(prev.h, line.h)) {
      const segments = [...prev.segments, ...line.segments];
      out[out.length - 1] = { ...prev, segments, text: segments.map((s) => s.text).join(' | ') };
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * pages: [{ page, width, lines }] → structured summary bill.
 */
function parseSummaryBill(pagesIn) {
  const pages = pagesIn.map((p) => ({ ...p, lines: attachAmountLines(p.lines) }));
  const issues = [];
  const patient = {};
  const categories = [];
  const totals = { gross: null, rounded: null, credit: null, paid: null, total: null };
  let invoiceNo = null;
  let inCharges = false;
  let totalAmountLines = 0;
  /** A bill the company pays in full prints no "PAID AMOUNT" line at all (Coal India). */
  let paidPrinted = false;
  let prevFirst = '';

  for (const { width, lines } of pages) {
    for (const line of lines) {
      const text = line.text.replace(/\s*\|\s*/g, '  ').trim();
      const first = line.segments[0];

      // "COMPANY: NORTHERN POWER DISTRIBUTION COMPANY OF" continues on the next line ("T.G. LTD").
      // The header repeats on every page — append the continuation once.
      const continuation = first?.text.trim();
      if (/^C[O0]MPANY\s*[:;]/i.test(prevFirst) && first && first.x0 < 0.4 * width && !continuation.includes(':')
        && patient.company && !patient.company.endsWith(continuation)) {
        patient.company += ` ${continuation}`;
      }
      prevFirst = first ? first.text.trim() : '';

      for (const seg of line.segments) {
        const t = seg.text.trim();
        let m;
        // Labels as OCR reads them too: "INV0ICE N0", "1P NO", "D.0.A".
        if ((m = /[I1l|]NV[O0][I1l|]CE\s*N[O0]\s*[:.]?\s*([A-Z0-9|!]+)/i.exec(t))) invoiceNo ||= repairInvoiceNo(m[1]);
        else if ((m = /^NAME\s*[:;]\s*(.+)$/i.exec(t))) patient.name ||= repairName(m[1].trim());
        else if ((m = /^[I1l|]P\s*N[O0]\s*[:;]\s*(\S+)/i.exec(t))) patient.ipNo ||= repairNumber(m[1]);
        else if ((m = /^YH\s*N[O0]\s*[:;]\s*(\S+)/i.exec(t))) patient.yhNo ||= repairNumber(m[1]);
        else if ((m = /^AGE\s*\/\s*SEX\s*[:;]\s*([\dIlO|]+)\s*Y?\s*\/?\s*([MFO])?/i.exec(t))) {
          const age = repairNumber(m[1]);
          if (/^\d+$/.test(age)) patient.age ||= Number(age);
          if (m[2]) patient.gender ||= { M: 'Male', F: 'Female', O: 'Other' }[m[2].toUpperCase()];
        } else if ((m = /^C[O0]NSULTANT\s*[:;]\s*(?:Dr\.?\s*)?(.+?)\s*(?:\(([^)]+)\))?\s*$/i.exec(t))) {
          patient.consultant ||= repairName(m[1].trim());
          if (m[2]) patient.consultantSpeciality ||= m[2].trim();
        } else if ((m = /^C[O0]MPANY\s*[:;]\s*(.+)$/i.exec(t))) patient.company ||= m[1].trim();
        else if ((m = /^D\.?[O0]\.?A\s*[:;]\s*(.+)$/i.exec(t))) patient.admission ||= parseDateTime(m[1]);
        else if ((m = /^D\.?[O0]\.?D\s*[:;]\s*(.+)$/i.exec(t))) patient.discharge ||= parseDateTime(m[1]);
        else if ((m = /^DISCH\s*STATUS\s*:\s*(.+)$/i.exec(t))) patient.dischargeStatus ||= m[1].trim();
      }

      if (/Description\s+of\s+Healthcare/i.test(text)) {
        inCharges = true;
        continue;
      }
      const last = line.segments[line.segments.length - 1];
      const amount = last ? parseAmount(last.text) : null;
      const label = line.segments.slice(0, -1).map((s) => s.text).join(' ').trim();

      // First "TOTAL AMOUNT" is the exact sum (paise), the second the rounded bill amount.
      if (/TOTAL\s+AMOUNT/i.test(text)) {
        inCharges = false;
        totalAmountLines += 1;
        if (totalAmountLines === 1) totals.gross = amount;
        else totals.rounded = amount;
        continue;
      }
      if (/CREDIT\s+FROM/i.test(text)) {
        totals.credit = { from: label.replace(/^CREDIT\s+FROM\s+/i, '').replace(/[:\s]+$/, ''), amount };
        continue;
      }
      if (/PAID\s+AMOUNT/i.test(text)) {
        paidPrinted = true;
        totals.paid = amount;
        continue;
      }
      if (/^TOTAL\s*:?/i.test(text) && !/AMOUNT/i.test(text)) {
        totals.total = amount;
        continue;
      }
      if (inCharges && label && line.segments.length >= 2) {
        if (/^AMOUNT$/i.test(label) || /^SAC/i.test(label)) continue;
        // An unreadable amount leaves fragments behind ("HAEMATOLOGY 14 O" for 6,144.00).
        const name = (amount == null ? label.replace(/(\s+[\dIlOo,.']+)+$/, '') : label).replace(/\s+/g, ' ');
        categories.push({ name, amount, amountRaw: last.text });
      }
    }
  }

  // One unreadable charge is derived from the total (and the other way round);
  // likewise credit + paid = total.
  const unreadable = categories.filter((c) => c.amount == null);
  if (unreadable.length === 1 && totals.gross != null) {
    const c = unreadable[0];
    c.amount = round2(totals.gross - sum(categories.filter((x) => x !== c).map((x) => x.amount)));
    c.corrected = true;
    issues.push({ level: 'info', message: `${c.name}: amount unreadable — derived from the total: ${c.amount.toFixed(2)}` });
  } else {
    for (const c of unreadable) issues.push({ level: 'warning', message: `${c.name}: amount "${c.amountRaw}" could not be read` });
  }
  const credit = totals.credit?.amount ?? null;
  if (totals.paid == null && credit != null && totals.total != null) {
    totals.paid = round2(totals.total - credit);
    // Not printed and nothing left to pay: the company pays the whole bill — nothing to report.
    if (paidPrinted) issues.push({ level: 'info', message: `Paid amount unreadable — derived as total − credit: ${totals.paid.toFixed(2)}` });
    else if (totals.paid !== 0) issues.push({ level: 'info', message: `No paid amount on the bill — worked out as total − credit: ${totals.paid.toFixed(2)}` });
  } else if (totals.total == null && credit != null && totals.paid != null) {
    totals.total = round2(credit + totals.paid);
  } else if (credit == null && totals.credit && totals.total != null && totals.paid != null) {
    totals.credit.amount = round2(totals.total - totals.paid);
    issues.push({ level: 'info', message: `Credit amount unreadable — derived as total − paid: ${totals.credit.amount.toFixed(2)}` });
  }
  const categoriesSum = sum(categories.map((c) => c.amount));
  if (totals.gross == null) {
    totals.gross = categoriesSum;
    issues.push({ level: 'info', message: `Total amount not readable — using the sum of the charges, ${categoriesSum.toFixed(2)}` });
  } else if (!sameAmount(totals.gross, categoriesSum)) {
    issues.push({ level: 'error', message: `Charges add up to ${categoriesSum.toFixed(2)} but the total amount reads ${totals.gross.toFixed(2)}` });
  }
  if (totals.rounded != null && Math.abs(Math.round(totals.gross) - totals.rounded) > 1) {
    issues.push({ level: 'error', message: `Rounded total ${totals.rounded.toFixed(2)} does not match ${totals.gross.toFixed(2)}` });
  }
  if (totals.total != null && totals.credit?.amount != null && totals.paid != null && !sameAmount(totals.credit.amount + totals.paid, totals.total)) {
    issues.push({ level: 'error', message: `Credit ${totals.credit.amount} + paid ${totals.paid} ≠ total ${totals.total}` });
  }
  if (!patient.ipNo) issues.push({ level: 'error', message: 'IP number not found on the bill' });
  if (!invoiceNo) issues.push({ level: 'warning', message: 'Invoice number not found' });

  return { format: 'yashoda-summary-bill', invoiceNo, patient, categories, totals, issues };
}

function parseStructured(format, pages) {
  if (format === 'yashoda-final-bill') return parseFinalBill(pages);
  if (format === 'yashoda-summary-bill') return parseSummaryBill(pages);
  return null;
}

module.exports = {
  detectFormat, parseStructured, parseFinalBill, parseSummaryBill, parseAmount, normalizeCode, codeFamily, parseQuantity,
  repairInvoiceNo, repairNumber, repairName,
};

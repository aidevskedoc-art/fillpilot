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
 * → { code, tariff: 'NIMS' | 'COMM' | null, raw, valid, own?, alternatives?, parts? }
 *   alternatives: other readings where the shape cannot settle I against 1
 *   (78I / 781) — the site's tariff list does.
 *   parts: the package codes of a line charged under several ("LB092+93+94" →
 *   LB092, LB093, LB094), see fixPackageCodes.
 */
function normalizeCode(raw, family = 'package') {
  if (!raw || !raw.trim()) return null;
  const own = raw.replace(/\s+/g, '').toUpperCase();
  if (OWN_CODES.has(own)) return { code: own, tariff: null, raw: raw.trim(), valid: true, own: true };
  const bhel = bhelCode(own, raw.trim());
  if (bhel) return bhel;
  const ehs = ehsCode(own, raw.trim());
  if (ehs) return ehs;
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
  const read = codeParts.map((p) => (asPackage(p) ? fixPackageCodes(p) : fixTariffCode(p)));
  const code = read.map((r) => r.code).join('/');
  const alternatives = read.length === 1 ? read[0].alternatives : [];
  const combined = read.length === 1 ? read[0].parts : null;
  const single = '[A-Z]{0,3}\\d+[A-Z]?';
  const valid = new RegExp(`^${single}(\\+${single})*$`).test(code) || /^[A-Z]\d+(\.\d+)+$/.test(code);
  return {
    code, tariff, raw: raw.trim(), valid: Boolean(code) && valid, ...(alternatives.length ? { alternatives } : {}), ...(combined ? { parts: combined } : {}),
  };
}

/**
 * The codes on a BHEL patient's bill (IP 132231, 2026-11-09), in two shapes:
 *   "E-1530"          an E code
 *   "3435(1000-30%)"  code 3435 at its base rate ₹1000 less 30% (the bill charges 700);
 *                     the closing bracket is often cut off by the column ("3462(28500-30%")
 * compact: the code without spaces, in capitals. Digits are read as digits (OCR's I, L, O).
 * → normalizeCode's result (with baseRate and discountPct for the second shape), or null for any other code.
 */
function bhelCode(compact, raw) {
  const e = /^E[-–—]([\dILO|!]{1,5})$/.exec(compact);
  if (e) {
    const digits = toDigits(e[1]);
    return { code: `E-${digits}`, tariff: null, raw, valid: /^\d+$/.test(digits) };
  }
  const d = /^([\dILO|!]{1,5})\(([\dILO|!,.]+)[-–—]([\dILO|!.]+)%\)?$/.exec(compact);
  if (!d) return null;
  const code = toDigits(d[1]);
  const baseRate = Number(toDigits(d[2]).replace(/,/g, ''));
  const discountPct = Number(toDigits(d[3]));
  const valid = /^\d+$/.test(code) && Number.isFinite(baseRate) && Number.isFinite(discountPct);
  return { code, tariff: null, raw, valid, ...(valid ? { baseRate, discountPct } : {}) };
}

/**
 * An EHS procedure code: digits in three or four dotted parts, printed without a
 * tariff mark — "51.22.6" LAPAROSCOPIC CHOLECYSTECTOMY, in TGNPDCL's EHS Ax-III
 * list (the client, 2026-11-11; others are in EHS Ax-II). At least two dots, so a
 * figure such as "350.00" is never taken for one. Digits are read as digits (OCR's
 * I, L, O); a stray dot at the end is dropped.
 * → normalizeCode's result with ehs: true, or null for any other code.
 */
function ehsCode(compact, raw) {
  const m = /^([\dILO|!]{1,3}(?:\.[\dILO|!]{1,3}){2,3})\.?$/.exec(compact);
  if (!m) return null;
  const code = toDigits(m[1]);
  return /^\d+(\.\d+)+$/.test(code) ? { code, tariff: null, raw, valid: true, ehs: true } : null;
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
 * Package codes charged as one line, the later ones printed without the letters
 * of the code before them (the client, 2026-11-06): "LB092+93+94" is LB092,
 * LB093 and LB094; "LB120+90+55+58" is LB120, LB090, LB055 and LB058 — the same
 * bill charges GLUCOSE as LB055 and CREATININE as LB058, so "55" is the digits,
 * not LB155; "RI029+RI030" is RI029 and RI030; "LB092+RI030+31" ends in RI031.
 * → { code: as printed (repaired), alternatives, parts?: the codes, only when every one reads as a package code }
 */
function fixPackageCodes(part) {
  if (!part.includes('+')) return { code: fixPackageCode(part), alternatives: [] };
  const [head, ...rest] = part.split('+');
  const first = fixPackageCode(head);
  let letters = /^[A-Z]{2}(?=\d{3}$)/.exec(first)?.[0];
  const printed = [first];
  const parts = [first];
  for (const piece of rest) {
    const digits = toDigits(piece);
    if (/^\d{1,3}$/.test(digits)) {
      printed.push(digits);
      parts.push(letters ? letters + digits.padStart(3, '0') : null);
    } else {
      const code = fixPackageCode(piece);
      printed.push(code);
      parts.push(code);
      if (/^[A-Z]{2}\d{3}$/.test(code)) letters = code.slice(0, 2);
    }
  }
  const whole = parts.every((c) => c && /^[A-Z]{2}\d{3}$/.test(c));
  return { code: printed.join('+'), alternatives: [], ...(whole ? { parts } : {}) };
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

/**
 * "2 Visit(s) x 350.00", "1 Time ( s ) x 75.00", "2 X 450.00", "1.5 Day(s) X 3,000.00" → { qty, unit, rate }.
 * A count can have a fraction (half a day): "1.5" must not be read as its "5".
 */
function parseQuantity(text) {
  const t = text || '';
  const m = /(\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*\(\s*s\s*\)\s*(?:[xX×]\s*([\dIlOo,.]+))?/.exec(t)
    || /(\d+(?:\.\d+)?)()\s*[xX×]\s*([\dIlOo,.]+)/.exec(t);
  if (!m) return {};
  return { qty: Number(m[1]), unit: m[2] || null, rate: m[3] ? parseAmount(m[3]) : null };
}

/** "PACKED CELLS 3 Unit(s) X 530.00": a count at the end of the item's name. */
const COUNT_IN_NAME = /(?:^|\s+)(\d+(?:\.\d+)?\s*[A-Za-z]+\s*\(\s*s\s*\)(?:\s*[xX×]\s*[\dIlOo,.]+)?)$/;

/**
 * A count printed (or scanned) a little left of the value column lands in the
 * item's name, and the count would quietly become 1: it is taken back out of
 * the name, ahead of whatever the value column holds ("X 530.00").
 */
function countFromName(row) {
  if (!row.desc || parseQuantity(row.value).qty != null) return row;
  const m = COUNT_IN_NAME.exec(row.desc);
  if (!m) return row;
  return { ...row, desc: row.desc.slice(0, m.index).trim(), value: `${m[1]} ${row.value || ''}`.trim() };
}

const isPunctuationOnly = (text) => /^[\s\-–.,:;'"`_|]*$/.test(text);

/** "1", "2.5", OCR's "I" or "l" for 1 → a quantity; anything else → null. */
function parseQty(text) {
  const s = toDigits(text || '').replace(/\s+/g, '');
  return /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? Number(s) : null;
}

// ------------------------------------------------------------- detection

function detectFormat(allLines) {
  const text = allLines.map((l) => l.text).join('\n');
  if (!/YASHODA/i.test(text)) return null;
  if (/BILL OF SUPPLY/i.test(text) && /INVOICE\s*NO/i.test(text)) return 'yashoda-summary-bill';
  if (/Charged\s+Amount/i.test(text) && /Sub\s*Total/i.test(text)) return 'yashoda-final-bill';
  // Last, so a final or summary bill is read as before whatever else its PDF holds.
  if (/PHARMACY\s+DETAILS/i.test(text) && /ITEM\s*ISSUES|TOTAL\s*ISSUE\s*AMOUNT|ITEM\s*DESCRIPTION/i.test(text)) return 'yashoda-pharmacy-bill';
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

/**
 * A line that starts with a date: "12/10/2026  ACTIVATED PARTIAL" — BHEL bills
 * date every lab test in front of its name (2026-11-09).
 */
const DATED_TEXT = /^([\dIlO|!]{1,2}[/.-][\dIlO|!]{1,2}[/.-][\dIlO|!]{4})\s+(.+)$/;
const DATE_ONLY = /^[\dIlO|!]{1,2}[/.-][\dIlO|!]{1,2}[/.-][\dIlO|!]{4}$/;

/**
 * Where a dated line's name starts on a page — right of its date. The name's
 * second and third lines sit there too, well right of the other items, and
 * must not be taken for the hospital stamp. null when no line is dated.
 */
function datedIndentOf(lines, width) {
  const xs = [];
  for (const line of lines) {
    const desc = line.segments.filter((s) => s.x0 / width < FINAL_COLUMNS.value);
    if (desc.length >= 2 && DATE_ONLY.test(desc[0].text.trim())) xs.push(desc[1].x0);
  }
  xs.sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : null;
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
  /** Pages the totals are printed on — a check about them opens the bill there. */
  let grandTotalPage = null;
  let netAmountPage = null;

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
    // A dated item's name continues under its first line, right of the date — not the stamp.
    const stampFrom = Math.max(itemIndent, datedIndentOf(lines, width) ?? 0) + STAMP_INDENT_GAP;
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
      if (!c.amount && c.descX != null && c.descX > stampFrom) continue; // stamp / signature
      const pos = page * 100000 + (100000 - line.y * 100); // reading order across pages

      if ([c.value, c.desc, c.code].some((t) => /sub\s*total/i.test(t))) {
        if (!group) newGroup(null);
        group.subTotal = parseAmount(c.amount);
        group.subTotalRaw = c.amount || null;
        group.subTotalPage = page;
        group.closed = true;
        continue;
      }
      if (/grand\s*total/i.test(text)) {
        grandTotal = parseAmount(c.amount);
        grandTotalPage = page;
        continue;
      }
      if (/^net\b/i.test(c.value) || /^net\s+amount/i.test(text)) {
        netAmount = parseAmount(c.amount);
        netAmountPage = page;
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
      // A dated line is an item's first line, never a heading.
      if (c.desc && !c.amount && !c.code && !c.value && c.descX != null && c.descX < itemIndent - GROUP_INDENT_GAP && !groupOpen && !DATED_TEXT.test(c.desc)) {
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
      const anchors = g.rows.filter((r) => r.kind === 'anchor').map(countFromName).map((r) => ({ ...r, parts: r.desc ? [{ pos: r.pos, text: r.desc }] : [] }));
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
        const texts = a.parts.sort((x, y) => x.pos - y.pos).map((p) => p.text);
        // "12/10/2026 ACTIVATED PARTIAL": the date in front of the name's first line is the item's date.
        const dated = texts.length ? DATED_TEXT.exec(texts[0]) : null;
        if (dated) texts[0] = dated[2];
        const description = texts.join(' ').replace(/\s+/g, ' ').trim();
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
          // Each code's share of the amount is set once the whole bill is read (shareCombinedCodes).
          ...(code?.parts ? { codeParts: code.parts.map((c) => ({ code: c, amount: null })) } : {}),
          ...(dated ? { date: parseDateTime(dated[1])?.date ?? null } : {}),
          // "3435(1000-30%)": the base rate and the discount the amount comes from.
          ...(code?.baseRate != null ? { baseRate: code.baseRate, discountPct: code.discountPct } : {}),
        };
        if (qtyNote) item.issues.push(qtyNote);
        if (code && !code.valid) item.issues.push(`Code "${code.raw}" may be misread`);
        if (item.baseRate != null && item.amount != null) {
          // Charged to the rupee: 1063 less 30% is 744.10, the bill says 744.00.
          const discounted = round2(item.baseRate * item.qty * (100 - item.discountPct) / 100);
          if (Math.abs(discounted - item.amount) > item.qty) {
            item.issues.push(`${item.baseRate} less ${item.discountPct}% is ${discounted}${item.qty > 1 ? ` for ${item.qty}` : ''}, but the amount reads ${item.amount}`);
          }
        }
        if (item.amount == null) item.issues.push(`Amount "${a.amount || ''}" could not be read`);
        if (item.amount != null && item.rate != null && q.qty && !sameAmount(round2(q.qty * item.rate), item.amount)) {
          item.issues.push(`${q.qty} × ${item.rate} = ${round2(q.qty * item.rate)}, but the amount reads ${item.amount}`);
        }
        return item;
      });
      // A check about the sub total opens the bill where it is printed (else at the group's last line).
      const page = g.subTotalPage ?? g.items[g.items.length - 1]?.page ?? null;
      delete g.rows;
      delete g.closed;
      delete g.subTotalPage;
      const subTotalPrinted = g.subTotal != null;
      reconcileGroup(s, g, issues, page);
      if (subTotalPrinted) settleCounts(g);
      computedTotal += g.subTotal ?? sum(g.items.map((i) => i.amount));
    }
  }
  computedTotal = round2(computedTotal);
  shareCombinedCodes(sections.flatMap((s) => s.groups.flatMap((g) => g.items)));

  const firstPage = pages[0]?.page ?? null;
  const lastPage = pages[pages.length - 1]?.page ?? null;
  grandTotalPage ??= lastPage;
  if (grandTotal == null) {
    issues.push({ level: 'info', message: `Grand total not readable — using the sum of the sections, ${computedTotal.toFixed(2)}`, page: grandTotalPage });
    grandTotal = computedTotal;
  } else if (!sameAmount(grandTotal, computedTotal)) {
    const gap = round2(grandTotal - computedTotal);
    // 4,01,645.90 read as 645.90: OCR dropped the leading digits, so the gap is a round number.
    const hint = gap > 0 && gap % 1000 === 0 ? ` — the difference ${gap.toFixed(2)} is a round number: a large amount probably lost its first digits in reading` : '';
    issues.push({ level: 'error', message: `Sections add up to ${computedTotal.toFixed(2)} but the grand total reads ${grandTotal.toFixed(2)}${hint}`, page: grandTotalPage });
  }
  if (netAmount != null && Math.abs(Math.round(grandTotal) - netAmount) > 1) {
    issues.push({ level: 'error', message: `Net amount ${netAmount.toFixed(2)} does not match the grand total ${grandTotal.toFixed(2)}`, page: netAmountPage ?? grandTotalPage });
  }
  if (!patient.ipNo) issues.push({ level: 'error', message: 'IP number not found on the bill', page: firstPage });

  for (const s of sections) {
    for (const g of s.groups) {
      for (const it of g.items) {
        // item: true — one line's own problem (also in it.issues); a claim that lists lines can say it on its line instead.
        for (const message of it.issues) issues.push({ level: 'warning', message: `${it.description || g.name}: ${message}`, page: it.page, item: true });
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
    grandTotalPage,
    issues,
  };
}

/**
 * A line charged under several package codes (ELECTROLYTES "LB092+93+94",
 * 390.00) is a service for each code, so its amount is shared out at the rate
 * the same bill charges each code on a line of its own (SODIUM LB092 120,
 * POTASSIUM LB093 120, CHLORIDES LB094 150). One code never charged alone takes
 * what is left. Where the bill cannot settle it — two such codes, or rates that
 * do not add up — the amount is shared equally and those parts carry a note:
 * a payer site that prices the code shows the difference.
 */
function shareCombinedCodes(items) {
  const rates = new Map();
  for (const it of items) {
    if (it.codeParts || !it.code || it.amount == null) continue;
    const rate = it.rate ?? round2(it.amount / (it.qty || 1));
    // A code charged at different rates on this bill has no one rate to go by.
    rates.set(it.code, rates.has(it.code) && rates.get(it.code) !== rate ? null : rate);
  }
  for (const it of items) {
    if (!it.codeParts || it.amount == null) continue;
    const qty = it.qty || 1;
    const each = round2(it.amount / qty);
    const known = it.codeParts.map((p) => rates.get(p.code) ?? null);
    const open = it.codeParts.filter((p, i) => known[i] == null);
    const rest = round2(each - sum(known));
    let shares;
    let unsure = [];
    let note = null;
    if (open.length ? rest > 0 : sameAmount(rest, 0)) {
      shares = known.map((r) => r ?? round2(rest / open.length));
      if (open.length > 1) {
        unsure = open;
        note = `The bill does not show how ${rest.toFixed(2)} of ${it.code} divides between ${open.map((p) => p.code).join(' and ')} — shared equally, check the site's amount`;
      }
    } else {
      shares = known.map(() => round2(each / known.length));
      unsure = it.codeParts;
      note = `The bill's own rates for ${it.codeParts.map((p) => p.code).join(', ')} do not add up to ${it.code}'s ${each.toFixed(2)} — shared equally, check the site's amount`;
    }
    // The last part takes the paise left by rounding, so the parts add up to the line.
    let left = it.amount;
    it.codeParts.forEach((p, i) => {
      p.amount = i === it.codeParts.length - 1 ? round2(left) : round2(shares[i] * qty);
      left -= p.amount;
      if (unsure.includes(p)) p.note = note;
    });
  }
}

/**
 * Items vs. "Sub Total...". When exactly one figure is unreadable it is
 * derived from the others (marked corrected); a disagreement between readable
 * figures is reported, never silently "fixed". page: where the sub total is printed.
 */
function reconcileGroup(section, g, issues, page = null) {
  const where = g.name || section.name;
  const known = g.items.filter((i) => i.amount != null);
  const missing = g.items.filter((i) => i.amount == null);
  const itemsSum = sum(known.map((i) => i.amount));

  if (g.subTotal == null && missing.length === 0) {
    if (g.subTotalRaw) issues.push({ level: 'info', message: `${where}: sub total "${g.subTotalRaw}" unreadable — using the items' sum ${itemsSum.toFixed(2)}`, page });
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
      issues.push({ level: 'info', message: `${where}: sub total read as "${g.subTotalRaw}" — using the items' sum ${itemsSum.toFixed(2)}`, page });
      g.subTotal = itemsSum;
      return;
    }
    issues.push({ level: 'error', message: `${where}: items add up to ${itemsSum.toFixed(2)} but the sub total reads ${g.subTotal.toFixed(2)}`, page });
    return;
  }
  if (missing.length > 1) {
    issues.push({ level: 'error', message: `${where}: ${missing.length} amounts could not be read`, page: missing[0].page ?? page });
  }
}

/**
 * A count misread while its amount is right: "2 Unit(s) X 530.00 … 1,590.00"
 * on a bill that says 3 (Somajiguda, 2026-11-12). The amounts are checked
 * against the printed sub total (and later the grand total and the summary
 * bill); the count is read once. So when the group adds up, the count is
 * amount ÷ rate — a whole number, or a half for days and hours — with the same
 * number of digits as the count read: one digit misread (2 for 3), not a rate
 * that lost a digit (53 for 530 would make 3 into 30). Marked for a person to check.
 */
function settleCounts(g) {
  if (!sameAmount(sum(g.items.map((i) => i.amount ?? 0)), g.subTotal)) return;
  const digits = (n) => String(n).replace(/\D/g, '').length;
  for (const it of g.items) {
    if (!it.rate || it.amount == null || it.corrected || it.baseRate != null) continue;
    if (sameAmount(round2(it.qty * it.rate), it.amount)) continue;
    const count = round2(it.amount / it.rate);
    const halves = /^(day|hour|hr)/i.test(it.unit || '');
    if (!(count > 0) || !Number.isInteger(halves ? count * 2 : count) || digits(count) !== digits(it.qty)) continue;
    const read = it.qty;
    it.issues = it.issues.filter((m) => !m.startsWith(`${read} × ${it.rate} = `));
    it.issues.push(`Quantity read as ${read}, but ${it.amount} ÷ ${it.rate} = ${count} and the sub total agrees — ${count} used; check it on the bill`);
    it.qty = count;
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
/**
 * The summary bill's header, printed again at the top of every page (GST NO, NAME, IP NO, COMPANY…) — never a
 * charge, though a second page starts in the middle of the charges (NTPC, IP 133130, 2026-11-13).
 */
const SUMMARY_HEADER = /^(GST\s*N[O0]|PAN\s*N[O0]|NAME\s*[:;]|[I1l|]P\s*N[O0]|C[O0]NSULTANT|C[O0]MPANY|GSTIN|PT\s*A[DH]+A+R|DISCH|AGE\s*\/|YH\s*N[O0]|D\.?\s*[O0]\.?\s*[AD]\s*[:;]|T[O0]KEN|BILL\s+OF\s+SUPPLY|YASHODA|PAGE\s+\d)/i;

/**
 * A line's amount (its last segment) and the text before it. An amount in lakhs that OCR split in two
 * — "9," | "48,215.31", or "9" | ",48,215.31" (NTPC, IP 133130) — is put back together: the comma shows
 * the digits belong to it.
 */
function lineAmount(segments) {
  const last = segments[segments.length - 1];
  const before = segments.slice(0, -1).map((s) => s.text).join(' ').trim();
  const amount = last ? parseAmount(last.text) : null;
  const tail = last ? last.text.trim() : '';
  const m = /(?:^|\s)(\d{1,2})\s*(,?)$/.exec(before);
  if (amount != null && m && (m[2] || tail.startsWith(',')) && /^,?\d{2},\d{3}(\.\d{1,2})?$/.test(tail)) {
    const joined = parseAmount(`${m[1]},${tail.replace(/^,/, '')}`);
    if (joined != null) return { amount: joined, label: before.slice(0, m.index).trim() };
  }
  return { amount, label: before };
}

/** "9,48,215.31" read as 48,215.31: the leading digits lost in reading — the whole ends in the same digits. */
const lostLead = (whole, part) => whole != null && part != null && whole > part && whole.toFixed(2).endsWith(part.toFixed(2));

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
  /** Where the totals are printed — a check about them opens the bill there. */
  let totalsPage = null;

  for (const { page, width, lines } of pages) {
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
      const { amount, label } = lineAmount(line.segments);

      // A bill with GST (NTPC, IP 133130, 2026-11-13): "GST: 1,995.00", then "TOTAL AMOUNT + GST : 9,50,210.00" —
      // the total with GST, not the rounded total (totals.gst, totals.withGst; set only when printed).
      if (/^G\s*S\s*T\s*:/i.test(text)) {
        totals.gst = amount;
        continue;
      }
      if (/TOTAL\s+AMOUNT\s*\+\s*G\s*S\s*T/i.test(text)) {
        inCharges = false;
        totals.withGst = amount;
        continue;
      }
      // First "TOTAL AMOUNT" is the exact sum (paise), the second the rounded bill amount.
      if (/TOTAL\s+AMOUNT/i.test(text)) {
        inCharges = false;
        totalsPage ??= page;
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
        if (/^AMOUNT$/i.test(label) || /^SAC/i.test(label) || SUMMARY_HEADER.test(label)) continue;
        // An unreadable amount leaves fragments behind ("HAEMATOLOGY 14 O" for 6,144.00).
        const name = (amount == null ? label.replace(/(\s+[\dIlOo,.']+)+$/, '') : label).replace(/\s+/g, ' ');
        categories.push({ name, amount, amountRaw: last.text, page });
      }
    }
  }
  const firstPage = pages[0]?.page ?? null;
  totalsPage ??= pages[pages.length - 1]?.page ?? null;

  // One unreadable charge is derived from the total (and the other way round);
  // likewise credit + paid = total. Several unreadable charges share what the
  // total leaves for them — said once, with that amount, so the gap is not
  // reported again as a wrong total; a claim builder can confirm them from the
  // final bill (unreadableCharges).
  const unreadable = categories.filter((c) => c.amount == null);
  // The total lost its lakhs in reading (9,48,215.31 → 48,215.31) while every charge was read: the charges' sum is the total.
  const charged = sum(categories.map((c) => c.amount));
  if (!unreadable.length && categories.length && lostLead(charged, totals.gross)) {
    issues.push({ level: 'info', message: `Total amount read as ${totals.gross.toFixed(2)} — its first digits were lost in reading; the charges add up to ${charged.toFixed(2)}, used`, page: totalsPage });
    totals.gross = charged;
  }
  // Likewise the credit (9,40,708.00 → 40,708): total − paid ends in the same digits.
  if (totals.credit?.amount != null && totals.total != null && totals.paid != null && lostLead(round2(totals.total - totals.paid), totals.credit.amount)) {
    const owed = round2(totals.total - totals.paid);
    issues.push({ level: 'info', message: `Credit read as ${totals.credit.amount.toFixed(2)} — its first digits were lost in reading; total − paid is ${owed.toFixed(2)}, used`, page: totalsPage });
    totals.credit.amount = owed;
  }
  let unreadableCharges = null;
  if (unreadable.length === 1 && totals.gross != null) {
    const c = unreadable[0];
    c.amount = round2(totals.gross - sum(categories.filter((x) => x !== c).map((x) => x.amount)));
    c.corrected = true;
    issues.push({ level: 'info', message: `${c.name}: amount unreadable — derived from the total: ${c.amount.toFixed(2)}`, page: c.page });
  } else {
    const rest = totals.gross != null ? round2(totals.gross - sum(categories.filter((x) => x.amount != null).map((x) => x.amount))) : null;
    if (unreadable.length > 1 && rest != null && rest > 0) {
      unreadableCharges = { names: unreadable.map((c) => c.name), amount: rest };
      issues.push({
        level: 'warning',
        code: 'unreadable-charges',
        message: `${unreadable.map((c) => c.name).join(', ')}: amounts could not be read ("${unreadable.map((c) => c.amountRaw).join('", "')}") — together they are ${rest.toFixed(2)}, what the total amount leaves for them`,
        page: unreadable[0].page,
      });
    } else {
      for (const c of unreadable) issues.push({ level: 'warning', message: `${c.name}: amount "${c.amountRaw}" could not be read`, page: c.page });
    }
  }
  const credit = totals.credit?.amount ?? null;
  if (totals.paid == null && credit != null && totals.total != null) {
    totals.paid = round2(totals.total - credit);
    // Not printed and nothing left to pay: the company pays the whole bill — nothing to report.
    if (paidPrinted) issues.push({ level: 'info', message: `Paid amount unreadable — derived as total − credit: ${totals.paid.toFixed(2)}`, page: totalsPage });
    else if (totals.paid !== 0) issues.push({ level: 'info', message: `No paid amount on the bill — worked out as total − credit: ${totals.paid.toFixed(2)}`, page: totalsPage });
  } else if (totals.total == null && credit != null && totals.paid != null) {
    totals.total = round2(credit + totals.paid);
  } else if (credit == null && totals.credit && totals.total != null && totals.paid != null) {
    totals.credit.amount = round2(totals.total - totals.paid);
    issues.push({ level: 'info', message: `Credit amount unreadable — derived as total − paid: ${totals.credit.amount.toFixed(2)}`, page: totalsPage });
  }
  const categoriesSum = sum(categories.map((c) => c.amount));
  if (totals.gross == null) {
    totals.gross = categoriesSum;
    issues.push({ level: 'info', message: `Total amount not readable — using the sum of the charges, ${categoriesSum.toFixed(2)}`, page: totalsPage });
  } else if (!unreadableCharges && !sameAmount(totals.gross, categoriesSum)) {
    issues.push({ level: 'error', message: `Charges add up to ${categoriesSum.toFixed(2)} but the total amount reads ${totals.gross.toFixed(2)}`, page: totalsPage });
  }
  if (totals.rounded != null && Math.abs(Math.round(totals.gross) - totals.rounded) > 1) {
    issues.push({ level: 'error', message: `Rounded total ${totals.rounded.toFixed(2)} does not match ${totals.gross.toFixed(2)}`, page: totalsPage });
  }
  if (totals.withGst != null && totals.gst != null && totals.gross != null && Math.abs(round2(totals.gross + totals.gst) - totals.withGst) > 1) {
    issues.push({ level: 'error', message: `Total amount + GST reads ${totals.withGst.toFixed(2)}, but ${totals.gross.toFixed(2)} + ${totals.gst.toFixed(2)} = ${round2(totals.gross + totals.gst).toFixed(2)}`, page: totalsPage });
  }
  if (totals.total != null && totals.credit?.amount != null && totals.paid != null && !sameAmount(totals.credit.amount + totals.paid, totals.total)) {
    issues.push({ level: 'error', message: `Credit ${totals.credit.amount} + paid ${totals.paid} ≠ total ${totals.total}`, page: totalsPage });
  }
  if (!patient.ipNo) issues.push({ level: 'error', message: 'IP number not found on the bill', page: firstPage });
  if (!invoiceNo) issues.push({ level: 'warning', message: 'Invoice number not found', page: firstPage });

  return { format: 'yashoda-summary-bill', invoiceNo, patient, categories, totals, issues, ...(unreadableCharges ? { unreadableCharges } : {}) };
}

// --------------------------------------------------------- pharmacy bill

/** "65816 09/10/2026": an indent's number and date, on a line of their own. */
const INDENT_LINE = /^([\dIlO|!]{3,})\s+([\dIlO|!]{1,2}[/.-][\dIlO|!]{1,2}[/.-][\dIlO|!]{4})$/;
const PHARMACY_HEADER = /PHARMACY\s+DETAILS|ITEM\s*DESCRIPTION|C\s*\/\s*F\s*TOTAL|PAGE\s*TOTAL|AUTHORI[SZ]ED\s*SIGNATORY/i;
/** A line of column headings only — the header's second line ("No", "Description  Date"). */
const HEADING_WORDS = /^(INDENT|NO\.?|DATE|ITEM|DESCRIPTION|BATCH|EXPIRY|QTY|PRICE|VALUE|C\s*\/\s*F|TOTAL|\s)+$/i;

/**
 * The pharmacy bill comes in two layouts: a narrow one (IP 131537: Indent No |
 * Date | Item Description | Qty | Value | C/F Total) and a wide one with Batch
 * No, Expiry Date and Price too (IP 132231, 2026-11-09). There the item, batch
 * and expiry sit closer than a column break (lines.js), so each line is read
 * word by word against its page's own header row: a number belongs to the
 * heading nearest its middle (numbers are right-aligned under it), and the
 * item's name is what lies left of the batch column (or of Qty). Places are
 * shares of the page width. Until a header row is read: the narrow layout's.
 */
const NARROW_LAYOUT = { bands: [['qty', 0.52], ['value', 0.63], ['carried', 0.8]], batchFrom: null };

/** A line's words; a segment without them (built by hand) is one word. */
const wordsOf = (line) => line.segments.flatMap((s) => s.words ?? [{ text: s.text, x0: s.x0, x1: s.x1 }]);
const middleOf = (w) => (w.x0 + w.x1) / 2;

/** The header row → { bands: [[column, from]], batchFrom } as shares of the width; null for any other line. */
function pharmacyLayout(line, width) {
  const words = wordsOf(line);
  const find = (re) => words.find((w) => re.test(w.text));
  const qty = find(/^qty$/i);
  const value = find(/^value$/i);
  if (!qty || !value) return null;
  const batch = find(/^batch/i);
  const expiry = find(/^expiry/i);
  const numeric = [['qty', qty], ['price', find(/^price$/i)], ['value', value], ['carried', find(/^c\s*\/\s*f/i)]].filter(([, w]) => w);
  const bands = numeric.map(([name, w], i) => {
    const before = i ? numeric[i - 1][1] : expiry ?? batch;
    // Half-way from the column before; left of Qty in the narrow layout, a little left of its heading.
    return [name, (before ? (middleOf(before) + middleOf(w)) / 2 : middleOf(w) - 0.06 * width) / width];
  });
  // Batch numbers start a little left of their heading (it is centred over them).
  return { bands, batchFrom: batch ? (batch.x0 - 0.035 * width) / width : null };
}

/** One line's words by column, as text: the item's name, Qty, Price, Value and the C/F (indent) total. */
function pharmacyColumns(line, layout, width) {
  const cols = { desc: [], qty: [], price: [], value: [], carried: [] };
  for (const w of wordsOf(line)) {
    const at = middleOf(w) / width;
    const band = [...layout.bands].reverse().find(([, from]) => at >= from);
    if (band) cols[band[0]].push(w.text);
    // Batch and expiry are not needed — kept out of the item's name.
    else if (layout.batchFrom == null || w.x0 / width < layout.batchFrom) cols.desc.push(w.text);
  }
  const text = (list) => list.join(' ').replace(/\s+/g, ' ').trim();
  return { desc: text(cols.desc), qty: text(cols.qty), price: text(cols.price), value: text(cols.value), carried: text(cols.carried) };
}

/**
 * pages: [{ page, width, lines }] → the pharmacy bill: the medicines and
 * consumables issued (and returned) to the patient, indent by indent.
 *   items: [{ date (yyyy-mm-dd), indentNo, description, qty, price, value, returned, page, issues }]
 * price: as printed in the wide layout, else null (Value is qty × price). Item
 * descriptions wrap over lines centred on the Qty / Value line, as on the
 * final bill. The items are checked against TOTAL ISSUE AMOUNT and TOTAL
 * RETURN AMOUNT (printed on the line below their label in the wide layout),
 * and those against NET AMOUNT, which is rounded to the rupee.
 */
function parsePharmacyBill(pages) {
  const issues = [];
  const patient = {};
  const anchors = [];
  const texts = [];
  let returned = false;
  /** Lines of one indent belong together: a description never joins another indent's item. */
  let block = 0;
  let indent = { no: null, date: null };
  const totals = { issued: null, returned: null, net: null };
  /** A total whose amount is on the next line ("TOTAL ISSUE AMOUNT:" over "8,16,992.70"). */
  let pending = null;
  let totalsPage = null;
  let layout = NARROW_LAYOUT;

  for (const { page, width, lines } of pages) {
    for (const line of lines) {
      const text = line.text.replace(/\s*\|\s*/g, ' ').trim();
      const nameMatch = new RegExp(`^${NAME_LABEL}\\s*(.+?)\\s+[I1l|]P\\s*N[o0]\\s*[:.;]?\\s*([\\dIlLO|!]+)`, 'i').exec(text);
      if (nameMatch) {
        patient.name ||= repairName(nameMatch[1].trim());
        patient.ipNo ||= repairNumber(nameMatch[2]);
        continue;
      }
      const header = pharmacyLayout(line, width);
      if (header) {
        layout = header;
        continue;
      }
      if (isHeaderLine(text) || PHARMACY_HEADER.test(text) || HEADING_WORDS.test(text) || isPunctuationOnly(text) || STAMP_TEXT.test(text)) continue;

      let m;
      const total = /TOTAL\s*ISSUE\s*AMOUNT/i.test(text) ? 'issued' : /TOTAL\s*RETURN\s*AMOUNT/i.test(text) ? 'returned' : /NET\s*AMOUNT/i.test(text) ? 'net' : null;
      if (total) {
        // Returns print as negative amounts; parseAmount reads the figure without the sign.
        const amount = parseAmount(text.replace(/^.*AMOUNT\s*[:;.]?/i, ''));
        if (amount == null) pending = total;
        else totals[total] = amount;
        totalsPage ??= page;
        continue;
      }
      if (pending) {
        const amount = parseAmount(text);
        const was = pending;
        pending = null;
        if (amount != null) {
          totals[was] = amount;
          continue;
        }
      }
      if (/ISSUES?\s*>{2,}/i.test(text)) {
        returned = false;
        block++;
        continue;
      }
      if (/RETURNS?\s*>{2,}|>{2,}.*RETURN/i.test(text)) {
        returned = true;
        block++;
        continue;
      }
      if ((m = INDENT_LINE.exec(text))) {
        indent = { no: repairNumber(m[1]), date: parseDateTime(m[2])?.date ?? null };
        block++;
        continue;
      }

      const c = pharmacyColumns(line, layout, width);
      const pos = page * 100000 + (100000 - line.y * 100); // reading order across pages
      // An amount alone in the C/F Total column is the indent's running total.
      if (!c.qty && !c.price && !c.value) {
        if (c.desc) texts.push({ pos, block, text: c.desc });
        continue;
      }
      anchors.push({ pos, page, block, indent, returned, qtyRaw: c.qty, priceRaw: c.price, valueRaw: c.value, parts: c.desc ? [{ pos, text: c.desc }] : [] });
    }
  }

  for (const t of texts) {
    const own = anchors.filter((a) => a.block === t.block);
    if (!own.length) continue;
    own.reduce((best, a) => (Math.abs(a.pos - t.pos) < Math.abs(best.pos - t.pos) ? a : best)).parts.push({ pos: t.pos, text: t.text });
  }

  const items = anchors.map((a) => {
    const item = {
      date: a.indent.date,
      indentNo: a.indent.no,
      description: a.parts.sort((x, y) => x.pos - y.pos).map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim(),
      qty: parseQty(a.qtyRaw),
      price: a.priceRaw ? parseAmount(a.priceRaw) : null,
      value: parseAmount(a.valueRaw),
      returned: a.returned,
      page: a.page,
      issues: [],
    };
    if (!item.description) item.issues.push('No item name could be read');
    if (item.qty == null) {
      item.issues.push(`Qty "${a.qtyRaw}" could not be read — entered as 1 at the full value; check it`);
      item.qty = 1;
      item.price = null;
    }
    if (item.value == null && item.price != null) {
      item.value = round2(item.price * item.qty);
      item.issues.push(`Value "${a.valueRaw}" could not be read — worked out as Price × Qty = ${item.value.toFixed(2)}`);
    } else if (item.value == null) item.issues.push(`Value "${a.valueRaw}" could not be read`);
    else if (item.price != null && Math.abs(item.price * item.qty - item.value) > 0.05) {
      item.issues.push(`Price ${item.price} × Qty ${item.qty} is not the Value ${item.value} — one of them is misread`);
      item.price = null;
    }
    if (!item.date) item.issues.push('No indent date above this item');
    return item;
  });

  // One unreadable value among the issues (or the returns) is what their printed total leaves.
  const reconcile = (list, printed, what) => {
    const missing = list.filter((i) => i.value == null);
    const known = sum(list.filter((i) => i.value != null).map((i) => i.value));
    if (printed == null) {
      if (list.length) issues.push({ level: 'warning', message: `${what} not readable — the items add up to ${known.toFixed(2)}`, page: totalsPage });
      return;
    }
    if (missing.length === 1) {
      const item = missing[0];
      item.value = round2(printed - known);
      item.issues = item.issues.filter((m) => !/could not be read/.test(m) || /^Qty/.test(m));
      item.issues.push(`Value derived from the ${what}: ${item.value.toFixed(2)}`);
    } else if (missing.length > 1) {
      issues.push({ level: 'error', message: `${missing.length} item values could not be read`, page: missing[0].page });
    } else if (!sameAmount(known, printed)) {
      issues.push({ level: 'error', message: `Items add up to ${known.toFixed(2)} but the ${what} reads ${printed.toFixed(2)}`, page: totalsPage });
    }
  };
  reconcile(items.filter((i) => !i.returned), totals.issued, 'TOTAL ISSUE AMOUNT');
  if (items.some((i) => i.returned) || totals.returned != null) reconcile(items.filter((i) => i.returned), totals.returned, 'TOTAL RETURN AMOUNT');

  const issued = totals.issued ?? sum(items.filter((i) => !i.returned).map((i) => i.value));
  const back = totals.returned ?? sum(items.filter((i) => i.returned).map((i) => i.value));
  const due = round2(issued - back);
  if (totals.net == null) {
    totals.net = due;
    issues.push({ level: 'info', message: `NET AMOUNT not readable — using issues − returns, ${due.toFixed(2)}`, page: totalsPage });
  } else if (Math.abs(totals.net - due) > 1) {
    // NET AMOUNT is rounded to the rupee (8,13,246.00 for 8,13,245.61): only more than that is a difference.
    issues.push({ level: 'error', message: `NET AMOUNT reads ${totals.net.toFixed(2)} but issues − returns = ${due.toFixed(2)}`, page: totalsPage });
  }
  if (!items.length) issues.push({ level: 'error', message: 'No items found on the pharmacy bill', page: pages[0]?.page ?? null });
  if (!patient.ipNo) issues.push({ level: 'error', message: 'IP number not found on the bill', page: pages[0]?.page ?? null });
  for (const it of items) {
    for (const message of it.issues) issues.push({ level: 'warning', message: `${it.description || 'Item'}: ${message}`, page: it.page });
  }

  return { format: 'yashoda-pharmacy-bill', patient, items, totals, issues };
}

function parseStructured(format, pages) {
  if (format === 'yashoda-final-bill') return parseFinalBill(pages);
  if (format === 'yashoda-summary-bill') return parseSummaryBill(pages);
  if (format === 'yashoda-pharmacy-bill') return parsePharmacyBill(pages);
  return null;
}

module.exports = {
  detectFormat, parseStructured, parseFinalBill, parseSummaryBill, parsePharmacyBill, parseAmount, normalizeCode, codeFamily, parseQuantity,
  repairInvoiceNo, repairNumber, repairName,
};

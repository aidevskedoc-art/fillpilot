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

/** OCR look-alikes inside a number: I l i | ! → 1, O o → 0. */
function parseAmount(text) {
  if (!text) return null;
  const s = String(text)
    .replace(/[Il|i!]/g, '1')
    .replace(/[Oo]/g, '0')
    .replace(/[\s'`]/g, '')
    .replace(/[^\d.,]/g, '');
  const m = /^(\d{1,3}(?:,\d{2,3})*|\d+)\.(\d{2})$/.exec(s);
  return m ? Number(`${m[1].replace(/,/g, '')}.${m[2]}`) : null;
}

const round2 = (n) => Math.round(n * 100) / 100;
const sameAmount = (a, b) => a != null && b != null && Math.abs(a - b) < 0.011;
const sum = (list) => round2(list.reduce((s, n) => s + (n || 0), 0));

/**
 * Tariff code as printed ("41A/NIMS", "2121/COMM.", "NIMS/11E", "R171+171/NIMS",
 * "S5.1.17"), repaired from OCR ("IIA/NIMS", "RI 71/NIMS", "75 IA/NIMS", "303/cou.").
 * → { code, tariff: 'NIMS' | 'COMM' | null, raw, valid }
 */
function normalizeCode(raw) {
  if (!raw || !raw.trim()) return null;
  const parts = raw.replace(/\s+/g, '').toUpperCase().split('/').filter(Boolean);
  let tariff = null;
  const codeParts = [];
  parts.forEach((part, i) => {
    if (/^N[I1L!|]M[S5]\.?$/.test(part)) tariff = 'NIMS';
    // "COMM." after the slash, as OCR mangles it: COPN. CORM. COU. CONUN. C02Q.F CO»N.F
    else if (i > 0 && /^C[O0][^/]{0,5}$/.test(part) && !/^C[O0]\d+$/.test(part)) tariff = 'COMM';
    else codeParts.push(fixCodePart(part));
  });
  const code = codeParts.join('/');
  const single = '[A-Z]{0,3}\\d+[A-Z]?';
  const valid = new RegExp(`^${single}(\\+${single})*$`).test(code) || /^[A-Z]\d+(\.\d+)+$/.test(code);
  return { code, tariff, raw: raw.trim(), valid: Boolean(code) && valid };
}

/** "IIA" → "11A", "RI71" → "R171", "75IA" → "751A": I/L read in place of 1 inside the number. */
function fixCodePart(part) {
  // The prefix letter is never I or L — those are the 1s being repaired.
  return part.replace(/^([A-HJ-KM-Z]?)([\dIL]+)([A-Z]?)((?:\+\d+)?)$/, (m, prefix, digits, suffix, plus) => {
    if (!/\d/.test(digits) && digits.length < 2) return m;
    return prefix + digits.replace(/[IL]/g, '1') + suffix + plus;
  });
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

/** Column boundaries as a share of page width (the bill layout is fixed). */
const FINAL_COLUMNS = { value: 0.4, code: 0.66, amount: 0.82 };
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

function isHeaderLine(text) {
  return /YASHODA\s+HEALTHCARE/i.test(text) || /^Name\s*:/i.test(text) || (/^Description\b/i.test(text) && /Charged/i.test(text)) || /^Page\s+\d+\s+of\s+\d+$/i.test(text);
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
      const nameMatch = /^Name\s*:\s*(.+?)\s+IP\s*No\s*[:.]?\s*(\d+)/i.exec(text);
      if (nameMatch) {
        patient.name ||= nameMatch[1].trim();
        patient.ipNo ||= nameMatch[2];
        continue;
      }
      if (isHeaderLine(text) || isPunctuationOnly(text) || STAMP_TEXT.test(text)) continue;

      const c = columns(line, width);
      if (!c.amount && c.descX != null && c.descX > itemIndent + STAMP_INDENT_GAP) continue; // stamp / signature
      const pos = page * 100000 + (100000 - line.y * 100); // reading order across pages

      if (/sub\s*total/i.test(c.value) || /sub\s*total/i.test(c.desc)) {
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

  // Rows → items: description lines join the nearest amount line of their group
  // (multi-line descriptions are printed centred on the amount).
  let computedTotal = 0;
  for (const s of sections) {
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
        const q = parseQuantity(a.value);
        const code = normalizeCode(a.code);
        const item = {
          description: a.parts.sort((x, y) => x.pos - y.pos).map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim(),
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
        };
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
    issues.push({ level: 'error', message: `Sections add up to ${computedTotal.toFixed(2)} but the grand total reads ${grandTotal.toFixed(2)}` });
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

function parseDateTime(text) {
  const m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\s+(\d{1,2}:\d{2}))?/.exec(text || '');
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
  let prevFirst = '';

  for (const { width, lines } of pages) {
    for (const line of lines) {
      const text = line.text.replace(/\s*\|\s*/g, '  ').trim();
      const first = line.segments[0];

      // "COMPANY: NORTHERN POWER DISTRIBUTION COMPANY OF" continues on the next line ("T.G. LTD").
      // The header repeats on every page — append the continuation once.
      const continuation = first?.text.trim();
      if (/^COMPANY\s*:/i.test(prevFirst) && first && first.x0 < 0.4 * width && !continuation.includes(':')
        && patient.company && !patient.company.endsWith(continuation)) {
        patient.company += ` ${continuation}`;
      }
      prevFirst = first ? first.text.trim() : '';

      for (const seg of line.segments) {
        const t = seg.text.trim();
        let m;
        if ((m = /INVOICE\s*NO\s*[:.]?\s*([A-Z0-9]+)/i.exec(t))) invoiceNo ||= m[1];
        else if ((m = /^NAME\s*:\s*(.+)$/i.exec(t))) patient.name ||= m[1].trim();
        else if ((m = /^IP\s*NO\s*:\s*(\S+)/i.exec(t))) patient.ipNo ||= m[1];
        else if ((m = /^YH\s*NO\s*:\s*(\S+)/i.exec(t))) patient.yhNo ||= m[1];
        else if ((m = /^AGE\s*\/\s*SEX\s*:\s*(\d+)\s*Y?\s*\/?\s*([MFO])?/i.exec(t))) {
          patient.age ||= Number(m[1]);
          if (m[2]) patient.gender ||= { M: 'Male', F: 'Female', O: 'Other' }[m[2].toUpperCase()];
        } else if ((m = /^CONSULTANT\s*:\s*(?:Dr\.?\s*)?(.+?)\s*(?:\(([^)]+)\))?\s*$/i.exec(t))) {
          patient.consultant ||= m[1].trim();
          if (m[2]) patient.consultantSpeciality ||= m[2].trim();
        } else if ((m = /^COMPANY\s*:\s*(.+)$/i.exec(t))) patient.company ||= m[1].trim();
        else if ((m = /^D\.?O\.?A\s*:\s*(.+)$/i.exec(t))) patient.admission ||= parseDateTime(m[1]);
        else if ((m = /^D\.?O\.?D\s*:\s*(.+)$/i.exec(t))) patient.discharge ||= parseDateTime(m[1]);
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
    issues.push({ level: 'info', message: `Paid amount unreadable — derived as total − credit: ${totals.paid.toFixed(2)}` });
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

module.exports = { detectFormat, parseStructured, parseFinalBill, parseSummaryBill, parseAmount, normalizeCode, parseQuantity };

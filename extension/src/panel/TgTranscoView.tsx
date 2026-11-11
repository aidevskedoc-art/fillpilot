// TG Transco Excel, on the panel's "Excel & PDF" tab: TG Transco takes a bill as
// its own Excel template, filled. Choose the HIS final bill and pharmacy bill
// Excel files; the server turns them into that file (backend/src/claims/tgtransco.js),
// as the billing team fills it. The person adds the dates the bills do not have
// (discharge, surgery), checks it here, saves it and sends it to TG Transco.
// Download waits for those dates: TG Transco wants a Service Date on every surgery
// and implant row, and the three dates in its box.
//
// It does not touch any website. The files and the result live in this view
// only — clearing it, choosing other files or closing the panel drops them.

import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { TgTranscoSheet, TgTranscoTariff } from '../../../web/projects/shared/src/api-types';
import { api, messageOf } from './api';
import { CheckIcon, DownloadIcon, SheetIcon, ShieldIcon, UploadIcon } from './Icons';
import { blobFromBase64, saveFile } from './save-file';

const TARIFFS: TgTranscoTariff[] = [
  'EHS SUPERSPECIALITY', 'EHS NON-SUPERSPECIALITY', 'CGHS NABH', 'CGHS NON-NABH', 'CGHS SUPERSPECIALITY', 'NIMS 2015', 'TATAMEMORIAL', 'NOT LISTED',
];
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const KIND: Record<TgTranscoSheet['documents'][number]['kind'], string> = { 'final-bill': 'final bill', 'pharmacy-bill': 'pharmacy bill' };

type DateKey = 'admission' | 'discharge' | 'surgery';
type Options = { admissionDate: string | null; dischargeDate: string | null; surgeryDate: string | null; tariffType: TgTranscoTariff };
const FIELD = { admission: 'admissionDate', discharge: 'dischargeDate', surgery: 'surgeryDate' } as const;
const LABEL: Record<DateKey, string> = { admission: 'date of admission', discharge: 'date of discharge', surgery: 'date of surgery' };
/** The rows that go on the date of surgery. */
const ON_SURGERY_DATE = new Set(['SURGERY CHARGES', 'IMPLANTS/MEDICAL APPLIANCES']);
const joined = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '');

/**
 * The dates TG Transco needs that the file does not have yet. Its Instructions sheet:
 * Service Dates are mandatory for surgery and implants, and the box wants the dates
 * of admission, discharge and surgery (if any). The bills give none of discharge and surgery.
 */
function datesNeeded(sheet: TgTranscoSheet | null) {
  if (!sheet) return { needed: [] as DateKey[], undated: 0 };
  const undated = sheet.rows.filter((r) => r.date == null && ON_SURGERY_DATE.has(r.head)).length;
  const needed: DateKey[] = [];
  if (!sheet.admissionDate) needed.push('admission');
  if (!sheet.dischargeDate) needed.push('discharge');
  if (!sheet.surgeryDate && undated > 0) needed.push('surgery');
  return { needed, undated };
}

const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
/** "01.08.2026" → "2026-08-01", the date input's value. */
const toInput = (date: string | null) => {
  const m = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(date ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
/** "2026-08-01" → "01/08/2026"; null while the date is not complete (typing a year passes 0002, 0020, 0202 first). */
const fromInput = (value: string) => {
  const m = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
};
/** The server's "01.08.2026" → "01/08/2026", to send back. */
const slashed = (date: string | null) => (date ? date.replace(/\./g, '/') : null);

export function TgTranscoView({ onError }: { onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [sheet, setSheet] = useState<TgTranscoSheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState('');
  const [dates, setDates] = useState<Record<DateKey, string>>({ admission: '', discharge: '', surgery: '' });
  const [tariff, setTariff] = useState<TgTranscoTariff>('EHS SUPERSPECIALITY');
  /** null = not chosen yet: the checks open by themselves when one of them is a problem. */
  const [showChecks, setShowChecks] = useState<boolean | null>(null);

  const shown = (s: TgTranscoSheet) => ({ admission: toInput(s.admissionDate), discharge: toInput(s.dischargeDate), surgery: toInput(s.surgeryDate) });

  /** What the file now has, as typed by the person — the dates FillPilot worked out are worked out again. */
  function current(): Options {
    return {
      admissionDate: sheet && !sheet.admissionAssumed ? slashed(sheet.admissionDate) : null,
      dischargeDate: slashed(sheet?.dischargeDate ?? null),
      surgeryDate: sheet && !sheet.surgeryAssumed ? slashed(sheet.surgeryDate) : null,
      tariffType: tariff,
    };
  }

  async function make(list: File[], options: Options) {
    setBusy(true);
    setSaved('');
    try {
      const fresh = await api.makeTgTranscoExcel(list, options);
      setSheet(fresh);
      setFiles(list);
      setDates(shown(fresh));
      setTariff(fresh.tariffType);
      setShowChecks(null);
    } catch (err) {
      onError(messageOf(err));
      // The dates or tariff asked for were not applied: show what the file has.
      if (sheet) {
        setDates(shown(sheet));
        setTariff(sheet.tariffType);
      }
    } finally {
      setBusy(false);
    }
  }

  function choose(list: FileList | null) {
    const all = Array.from(list ?? []);
    if (input.current) input.current.value = '';
    const chosen = all.filter((f) => /\.xlsx$/i.test(f.name));
    if (!chosen.length) {
      if (all.length) {
        setNote(all.some((f) => /\.xls$/i.test(f.name))
          ? 'These are old .xls files — open them in Excel, save them as "Excel Workbook (.xlsx)" and choose those.'
          : 'Choose the two HIS Excel files (.xlsx): the final bill and the pharmacy bill.');
      }
      return;
    }
    if (busy) return;
    setNote(chosen.length === 1 ? 'Only one file was chosen — choose the final bill and the pharmacy bill together.' : '');
    // Other files may be another patient: their dates start again.
    make(chosen, { admissionDate: null, dischargeDate: null, surgeryDate: null, tariffType: tariff });
  }

  function changeDate(key: DateKey, value: string) {
    setDates((d) => ({ ...d, [key]: value }));
    if (!files.length || !sheet) return;
    const date = value === '' ? null : fromInput(value);
    // A date still being typed waits; a cleared one is taken out.
    if (value !== '' && !date) return;
    const options = current();
    const field = FIELD[key];
    if (date !== null && options[field] === date) return;
    options[field] = date;
    make(files, options);
  }

  function changeTariff(value: TgTranscoTariff) {
    setTariff(value);
    if (files.length) make(files, { ...current(), tariffType: value });
  }

  function download() {
    if (!sheet || datesNeeded(sheet).needed.length) return;
    saveFile(blobFromBase64(sheet.fileBase64, XLSX), sheet.fileName);
    setSaved(`${sheet.fileName} is in your Downloads folder — send it to TG Transco with the bill, as their Instructions sheet says.`);
  }

  function clear() {
    setSheet(null);
    setFiles([]);
    setDates({ admission: '', discharge: '', surgery: '' });
    setSaved('');
    setNote('Cleared. Nothing of these files is kept.');
  }

  const errors = sheet?.checks.filter((c) => c.level === 'error') ?? [];
  const others = sheet?.checks.filter((c) => c.level !== 'error') ?? [];
  const warnings = others.filter((c) => c.level === 'warning');
  const checksOpen = showChecks ?? (errors.length > 0 || warnings.length > 0);
  const { needed, undated } = datesNeeded(sheet);
  const drop = {
    onDragOver: (e: DragEvent) => { e.preventDefault(); setOver(true); },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files); },
  };
  const dateField = (key: DateKey, label: string) => (
    <label className="field">
      {label}
      <input
        className={`input input-sm${needed.includes(key) ? ' input-needed' : ''}`}
        type="date" value={dates[key]} disabled={busy} onChange={(e) => changeDate(key, e.target.value)}
      />
    </label>
  );

  return (
    <>
      <section className="section">
        <div className="label">TG Transco Excel · from the HIS files</div>
        <input ref={input} type="file" accept={`.xlsx,${XLSX}`} multiple hidden onChange={(e) => choose(e.target.files)} />

        {!sheet && (
          <button type="button" className={`dropzone${over ? ' over' : ''}`} disabled={busy} onClick={() => input.current?.click()} {...drop}>
            <span className="drop-icon"><SheetIcon size={18} /></span>
            <span className="strong">{busy ? 'Making the TG Transco Excel…' : 'Drop the two HIS Excel files here'}</span>
            <span className="muted small">The final bill and the pharmacy bill (.xlsx), or click to choose them</span>
          </button>
        )}

        {sheet && (
          <div className="card bill" {...drop}>
            <div className="bill-name truncate">{sheet.patient.name ?? 'Patient'}</div>
            <div className="chips">
              <span className="chip">IP {sheet.patient.ipNo ?? '?'}</span>
              <span className="chip">{sheet.rows.length} rows</span>
              <span className="chip">{rupees(sheet.totals.excel)}</span>
            </div>
            <div className="muted small mt-sm">{sheet.documents.map((d) => KIND[d.kind]).join('  +  ')}</div>

            <div className="spdcl-options mt">
              {dateField('admission', 'Date of admission')}
              {dateField('discharge', 'Date of discharge')}
              {dateField('surgery', 'Date of surgery')}
              <label className="field">
                Tariff type
                <select className="input input-sm" value={tariff} disabled={busy} onChange={(e) => changeTariff(e.target.value as TgTranscoTariff)}>
                  {TARIFFS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            </div>
            {needed.length > 0 && (
              <div className="msg msg-warn mt-sm">
                <span>
                  Enter the {joined(needed.map((k) => LABEL[k]))} above — the HIS bills do not have {needed.length > 1 ? 'them' : 'it'}.
                  {needed.includes('surgery') && ` Until then the ${undated} surgery and implant row(s) have no Service Date, which TG Transco requires.`}
                </span>
              </div>
            )}
            <div className="muted small mt-sm">
              {sheet.admissionAssumed ? 'Admission is the earliest date on the bills. ' : ''}
              Surgery and implants go on the date of surgery, and rows from that date are PACKAGE.
            </div>

            {(errors.length > 0 || others.length > 0) && (
              <div className="row-inline wrap mt">
                <button className="btn btn-secondary btn-sm" onClick={() => setShowChecks(!checksOpen)}>
                  {checksOpen ? '▾' : '▸'} Checks
                  {errors.length > 0 && <span className="tag tag-danger">{errors.length}</span>}
                  {warnings.length > 0 && <span className="tag tag-warn">{warnings.length}</span>}
                </button>
              </div>
            )}
            {checksOpen && (
              <div className="mt-sm">
                {errors.map((c) => <div key={c.message} className="warn-line bad">✗ {c.message}</div>)}
                {others.map((c) => <div key={c.message} className={`warn-line${c.level === 'info' ? ' muted' : ''}`}>{c.level === 'info' ? 'ℹ' : '⚠'} {c.message}</div>)}
              </div>
            )}
          </div>
        )}

        {busy && <div className="bar sweep mt"><span /></div>}
        {!sheet && !busy && <div className="safe mt"><ShieldIcon size={14} /> Made from the files and handed back — nothing is stored</div>}
        {note && <div className="warn-line">{note}</div>}
      </section>

      {sheet && (
        <section className="section">
          <details className="preview" open>
            <summary>Rows per Service_Type</summary>
            {sheet.heads.map((h) => (
              <div key={h.head} className="small">{h.head} — {h.rows} row(s) · {rupees(h.amount)}</div>
            ))}
          </details>
          <details className="preview">
            <summary>All {sheet.rows.length} rows</summary>
            {sheet.rows.map((r, i) => (
              <div key={i} className="small">
                {r.date ?? '—'} · {r.head}{r.packageType === 'PACKAGE' ? ' · package' : ''} · {r.code ? `${r.code} ` : ''}{r.description} — {r.qty} × {rupees(r.rate)} = {rupees(r.amount)}
              </div>
            ))}
          </details>
          <div className="small mt-sm">
            Total <span className="strong">{rupees(sheet.totals.excel)}</span> (package {rupees(sheet.totals.package)}) · HIS bill {rupees(sheet.totals.hisBill)}
            {Math.abs(sheet.totals.difference) >= 0.01 ? ` · difference ${rupees(sheet.totals.difference)}` : ''}
          </div>

          {errors.length > 0 && <div className="warn-line bad">Check the errors above before sending this file.</div>}
          <button className="btn btn-primary btn-block mt" disabled={busy || needed.length > 0} onClick={download}>
            <DownloadIcon size={14} /> {needed.length > 0 ? `Enter the ${joined(needed.map((k) => LABEL[k]))} to download` : 'Download TG Transco Excel'}
          </button>
          {saved && <div className="msg msg-success mt-sm">{saved}</div>}
          <div className="row-inline wrap mt-sm">
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => input.current?.click()}>
              <UploadIcon size={13} /> Other files
            </button>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={clear}>
              <CheckIcon size={13} /> Finished — clear
            </button>
          </div>
        </section>
      )}

      <footer className="footer">
        <div className="safe"><ShieldIcon size={14} /> Makes the file only — you send it to TG Transco yourself</div>
      </footer>
    </>
  );
}

// SPDCL mode: the SPDCL site takes a claim only as an Excel upload in its own
// template. Choose the HIS final bill and pharmacy bill Excel files; the server
// turns them into that file (backend/src/claims/spdcl.js): one row per service
// or medicine per day. The person checks it here, saves it, and uploads it on
// the SPDCL site themselves.
//
// Reached from any page: it does not touch the website. The files and the
// result live in this view only — closing it or choosing other files drops them.

import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { SpdclSheet, SpdclTariff } from '../../../web/projects/shared/src/api-types';
import { api, messageOf } from './api';
import { CheckIcon, DownloadIcon, SheetIcon, ShieldIcon, UploadIcon } from './Icons';
import { blobFromBase64, saveFile } from './save-file';

const TARIFFS: SpdclTariff[] = ['EHS', 'CGHS', 'NIMS_2015', 'COVID_TARIFF'];
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const KIND: Record<SpdclSheet['documents'][number]['kind'], string> = { 'final-bill': 'final bill', 'pharmacy-bill': 'pharmacy bill' };

const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
/** "26/09/2026" → "2026-09-26", the date input's value. */
const toInput = (date: string | null) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
/** "2026-09-26" → "26/09/2026"; null while the date is not complete (typing a year passes 0002, 0020, 0202 first). */
const fromInput = (value: string) => {
  const m = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
};

export function SpdclView({ onClose, onError }: { onClose: () => void; onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [sheet, setSheet] = useState<SpdclSheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState('');
  const [admission, setAdmission] = useState('');
  const [tariff, setTariff] = useState<SpdclTariff>('EHS');
  const [showChecks, setShowChecks] = useState<boolean | null>(null);

  async function make(list: File[], options: { admissionDate: string | null; tariffType: SpdclTariff }) {
    setBusy(true);
    setSaved('');
    try {
      const fresh = await api.makeSpdclExcel(list, options);
      setSheet(fresh);
      setFiles(list);
      setAdmission(toInput(fresh.admissionDate));
      setTariff(fresh.tariffType);
      setShowChecks(null);
    } catch (err) {
      onError(messageOf(err));
      // The date or tariff asked for was not applied: show what the file has.
      if (sheet) {
        setAdmission(toInput(sheet.admissionDate));
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
    // Other files may be another patient: the admission date is worked out again.
    make(chosen, { admissionDate: null, tariffType: tariff });
  }

  function changeAdmission(value: string) {
    setAdmission(value);
    const date = fromInput(value);
    if (date && files.length && date !== sheet?.admissionDate) make(files, { admissionDate: date, tariffType: tariff });
  }

  function changeTariff(value: SpdclTariff) {
    setTariff(value);
    if (!files.length) return;
    make(files, { admissionDate: sheet && !sheet.admissionAssumed ? sheet.admissionDate : null, tariffType: value });
  }

  function download() {
    if (!sheet) return;
    saveFile(blobFromBase64(sheet.fileBase64, XLSX), sheet.fileName);
    setSaved(`${sheet.fileName} is in your Downloads folder. Upload it on the SPDCL site.`);
  }

  function clear() {
    setSheet(null);
    setFiles([]);
    setAdmission('');
    setSaved('');
    setNote('Cleared. Nothing of these files is kept.');
  }

  const errors = sheet?.checks.filter((c) => c.level === 'error') ?? [];
  const warnings = sheet?.checks.filter((c) => c.level !== 'error') ?? [];
  const checksOpen = showChecks ?? (errors.length > 0 || warnings.some((c) => c.level === 'warning'));
  const drop = {
    onDragOver: (e: DragEvent) => { e.preventDefault(); setOver(true); },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files); },
  };

  return (
    <>
      <section className="section">
        <div className="row-inline" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <div className="label" style={{ marginBottom: 0 }}>SPDCL Excel · from the HIS files</div>
          <button className="btn btn-text btn-sm" onClick={onClose} disabled={busy}>Close</button>
        </div>
        <input ref={input} type="file" accept={`.xlsx,${XLSX}`} multiple hidden onChange={(e) => choose(e.target.files)} />

        {!sheet && (
          <button type="button" className={`dropzone${over ? ' over' : ''}`} disabled={busy} onClick={() => input.current?.click()} {...drop}>
            <span className="drop-icon"><SheetIcon size={18} /></span>
            <span className="strong">{busy ? 'Making the SPDCL Excel…' : 'Drop the two HIS Excel files here'}</span>
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
              <label className="field">
                Admission date
                <input className="input input-sm" type="date" value={admission} disabled={busy} onChange={(e) => changeAdmission(e.target.value)} />
              </label>
              <label className="field">
                Tariff type
                <select className="input input-sm" value={tariff} disabled={busy} onChange={(e) => changeTariff(e.target.value as SpdclTariff)}>
                  {TARIFFS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            </div>
            <div className="muted small mt-sm">
              {sheet.admissionAssumed ? 'The earliest date on the bills. ' : ''}
              Undated lines (room, ICU, visits, tests) are dated from the admission date, so change it if the patient was admitted earlier.
            </div>

            {(errors.length > 0 || warnings.length > 0) && (
              <div className="row-inline wrap mt">
                <button className="btn btn-secondary btn-sm" onClick={() => setShowChecks(!checksOpen)}>
                  {checksOpen ? '▾' : '▸'} Checks
                  {errors.length > 0 && <span className="tag tag-danger">{errors.length}</span>}
                  {warnings.filter((c) => c.level === 'warning').length > 0 && <span className="tag tag-warn">{warnings.filter((c) => c.level === 'warning').length}</span>}
                </button>
              </div>
            )}
            {checksOpen && (
              <div className="mt-sm">
                {errors.map((c) => <div key={c.message} className="warn-line bad">✗ {c.message}</div>)}
                {warnings.map((c) => <div key={c.message} className={`warn-line${c.level === 'info' ? ' muted' : ''}`}>{c.level === 'info' ? 'ℹ' : '⚠'} {c.message}</div>)}
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
              <div key={h.head} className="small">{h.head.trim()} — {h.rows} row(s) · {rupees(h.amount)}</div>
            ))}
          </details>
          <details className="preview">
            <summary>All {sheet.rows.length} rows</summary>
            {sheet.rows.map((r, i) => (
              <div key={i} className="small">
                {r.date ?? '—'} · {r.head.trim()} · {r.code ? `${r.code} ` : ''}{r.description} — {r.qty} × {rupees(r.rate)} = {rupees(r.amount)}
              </div>
            ))}
          </details>
          <div className="small mt-sm">
            SPDCL total <span className="strong">{rupees(sheet.totals.excel)}</span> · HIS bill {rupees(sheet.totals.hisBill)}
            {Math.abs(sheet.totals.difference) >= 0.01 ? ` · difference ${rupees(sheet.totals.difference)}` : ''}
          </div>

          {errors.length > 0 && <div className="warn-line bad">Check the errors above before uploading this file.</div>}
          <button className="btn btn-primary btn-block mt" disabled={busy} onClick={download}>
            <DownloadIcon size={14} /> Download SPDCL Excel
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
        <div className="safe"><ShieldIcon size={14} /> Makes the file only — you upload it on the SPDCL site yourself</div>
      </footer>
    </>
  );
}

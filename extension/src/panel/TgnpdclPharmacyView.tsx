// TGNPDCL pharmacy Excel, on the panel's "Excel & PDF" tab: the pharmacy bill
// alone (its PDF, read with OCR, or the HIS Excel) → TGNPDCL's own pharmacy
// upload Excel, for the "Upload Excel" button on the site's "3. Pharmacy" tab.
// The same rows and file the TGNPDCL bill view's Pharmacy tab makes — here
// without the final bill or the website. The files and the result live in
// this view only: clearing it, choosing another file or closing the panel drops them.

import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { TgnpdclPharmacySheet } from '../../../web/projects/shared/src/api-types';
import { api, messageOf } from './api';
import { BillChecks, useBillPdfs } from './CheckList';
import { CheckIcon, DownloadIcon, SheetIcon, ShieldIcon, UploadIcon } from './Icons';
import { blobFromBase64, saveFile } from './save-file';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SOURCE: Record<TgnpdclPharmacySheet['bill']['source'], string> = { pdf: 'pharmacy bill PDF', excel: 'pharmacy bill Excel' };

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
/** "2026-10-09" → "09/10/2026", as the site shows dates. */
const dayMonthYear = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : 'no date');

export function TgnpdclPharmacyView({ onError }: { onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<TgnpdclPharmacySheet | null>(null);
  /** Seconds since reading started; null when nothing is being read. */
  const [reading, setReading] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState('');
  /** null = not chosen yet: the checks open by themselves when one of them is a problem. */
  const [showChecks, setShowChecks] = useState<boolean | null>(null);
  /** The PDF just read — a check opens it at its page. */
  const pdfs = useBillPdfs();

  async function read(list: FileList | null) {
    const files = Array.from(list ?? []).filter((f) => /\.(pdf|xlsx)$/i.test(f.name) || f.type === 'application/pdf');
    if (files.length !== 1) {
      if (list?.length) setNote(files.length > 1 ? 'Choose one file — the pharmacy bill.' : 'Choose the pharmacy bill — its PDF or the HIS Excel (.xlsx).');
      return;
    }
    if (reading !== null) return;
    setNote('');
    setSaved('');
    setReading(0);
    const started = Date.now();
    const timer = window.setInterval(() => setReading(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      const fresh = await api.makeTgnpdclPharmacyExcel(files);
      pdfs.hold(files, fresh.documents);
      setSheet(fresh);
      setShowChecks(null);
      if (!fresh.rows.length) setNote('The pharmacy bill has no item to enter.');
    } catch (err) {
      onError(messageOf(err));
    } finally {
      window.clearInterval(timer);
      setReading(null);
      if (input.current) input.current.value = '';
    }
  }

  function download() {
    if (!sheet?.file) return;
    saveFile(blobFromBase64(sheet.file.base64, XLSX), sheet.file.fileName);
    setSaved(`${sheet.file.fileName} is in your Downloads folder — upload it with the "Upload Excel" button on the site's "3. Pharmacy" tab.`);
  }

  function clear() {
    pdfs.release();
    setSheet(null);
    setSaved('');
    setNote('Cleared. Nothing of this bill is kept.');
  }

  const isReading = reading !== null;
  const errors = sheet?.checks.filter((c) => c.level === 'error') ?? [];
  const warnings = sheet?.checks.filter((c) => c.level === 'warning') ?? [];
  const checksOpen = showChecks ?? (errors.length > 0 || warnings.length > 0);
  const total = sheet ? Math.round(sheet.rows.reduce((s, r) => s + r.amount, 0) * 100) / 100 : 0;
  const pouches = sheet?.rows.filter((r) => r.pouch) ?? [];
  const drop = {
    onDragOver: (e: DragEvent) => { e.preventDefault(); setOver(true); },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => { e.preventDefault(); setOver(false); read(e.dataTransfer.files); },
  };

  return (
    <>
      <section className="section">
        <div className="label">TGNPDCL pharmacy Excel · from the pharmacy bill</div>
        <input ref={input} type="file" accept={`application/pdf,.pdf,.xlsx,${XLSX}`} hidden onChange={(e) => read(e.target.files)} />

        {!sheet && (
          <button type="button" className={`dropzone${over ? ' over' : ''}`} disabled={isReading} onClick={() => input.current?.click()} {...drop}>
            <span className="drop-icon"><SheetIcon size={18} /></span>
            <span className="strong">{reading !== null ? `Reading the pharmacy bill… ${clock(reading)}` : 'Drop the pharmacy bill here'}</span>
            <span className="muted small">{isReading ? 'A scanned PDF is read page by page.' : 'Its PDF or the HIS Excel (.xlsx), or click to choose it'}</span>
          </button>
        )}

        {sheet && (
          <div className="card bill" {...drop}>
            <div className="bill-name truncate">{sheet.patient.name ?? 'Patient'}</div>
            <div className="chips">
              <span className="chip">IP {sheet.patient.ipNo ?? '?'}</span>
              <span className="chip">{sheet.rows.length} item(s)</span>
              <span className="chip">{rupees(total)}</span>
            </div>
            <div className="muted small mt-sm">
              {SOURCE[sheet.bill.source]}{sheet.documents[0]?.pageCount ? ` · ${sheet.documents[0].pageCount} p.` : ''}
              {' · '}net amount {rupees(sheet.bill.net)}{sheet.bill.returned ? ` (returns ${rupees(sheet.bill.returned)} taken off)` : ''}
            </div>

            {sheet.checks.length > 0 && (
              <div className="row-inline wrap mt">
                <button className="btn btn-secondary btn-sm" onClick={() => setShowChecks(!checksOpen)}>
                  {checksOpen ? '▾' : '▸'} Checks
                  {errors.length > 0 && <span className="tag tag-danger">{errors.length}</span>}
                  {warnings.length > 0 && <span className="tag tag-warn">{warnings.length}</span>}
                </button>
              </div>
            )}
            {checksOpen && <BillChecks checks={sheet.checks} pdfs={pdfs} />}
          </div>
        )}

        {isReading && <div className="bar sweep mt"><span /></div>}
        {!sheet && !isReading && <div className="safe mt"><ShieldIcon size={14} /> Made from the bill and handed back — nothing is stored</div>}
        {note && <div className="warn-line">{note}</div>}
      </section>

      {sheet && (
        <section className="section">
          {sheet.rows.length > 0 && (
            <details className="preview" open>
              <summary>{sheet.rows.length} item(s) · {rupees(total)}</summary>
              {sheet.rows.map((r, i) => (
                <div key={`${i}|${r.name}`} className="small">
                  {dayMonthYear(r.date)} — {r.name} — {r.qty} × {rupees(r.rate)} = {rupees(r.amount)}{r.pouch ? ' · pouch' : ''}
                </div>
              ))}
            </details>
          )}
          {pouches.length > 0 && (
            <div className="warn-line">
              ✎ Enclose the pouches of {pouches.length} item(s) costing ₹2,000 or more each ({pouches.reduce((n, r) => n + r.qty, 0)} pouch(es)) with the original bill.
            </div>
          )}

          {errors.length > 0 && <div className="warn-line bad">Check the errors above before uploading this file.</div>}
          <button className="btn btn-primary btn-block mt" disabled={isReading || !sheet.file} onClick={download}>
            <DownloadIcon size={14} /> Download TGNPDCL pharmacy Excel
          </button>
          {saved && <div className="msg msg-success mt-sm">{saved}</div>}
          <div className="row-inline wrap mt-sm">
            <button className="btn btn-secondary btn-sm" disabled={isReading} onClick={() => input.current?.click()}>
              <UploadIcon size={13} /> {reading !== null ? `Reading… ${clock(reading)}` : 'Other file'}
            </button>
            <button className="btn btn-secondary btn-sm" disabled={isReading} onClick={clear}>
              <CheckIcon size={13} /> Finished — clear
            </button>
          </div>
        </section>
      )}

      <footer className="footer">
        <div className="safe"><ShieldIcon size={14} /> Makes the file only — you upload it on the TGNPDCL site yourself</div>
      </footer>
    </>
  );
}

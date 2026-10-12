// Upload PDFs from the panel: the files go to the server to be read (text
// extraction / OCR happen there, not in the browser), and the panel waits
// until each one is read. Whether the server keeps the PDF afterwards is its
// setting (KEEP_PDF) — the result shows when it was not kept.

import { useRef, useState } from 'react';
import type { DocumentDto } from '../../../web/projects/shared/src/api-types';
import { api, messageOf } from './api';
import { UploadIcon } from './Icons';

/** Scanned PDFs are read page by page with OCR, so allow for a long one. */
const MAX_WAIT_MS = 8 * 60 * 1000;
const POLL_MS = 1500;

const KIND: Record<string, string> = {
  'yashoda-final-bill': 'final bill',
  'yashoda-summary-bill': 'summary bill',
};

const finished = (d: DocumentDto) => d.status === 'completed' || d.status === 'failed';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function UploadPdfs({ label, disabled, onDone, onError }: {
  label: string;
  disabled?: boolean;
  /** Called once reading has ended, with the documents that were read successfully. */
  onDone: (read: DocumentDto[]) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [items, setItems] = useState<DocumentDto[]>([]);
  const [refused, setRefused] = useState<string[]>([]);

  async function upload(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length || busy || disabled) return;
    setBusy(true);
    setItems([]);
    setRefused([]);
    try {
      const sent = await api.upload(files);
      setRefused(sent.rejected.map((r) => `${r.fileName}: ${r.error}`));
      let docs = sent.documents;
      setItems(docs);
      const deadline = Date.now() + MAX_WAIT_MS;
      while (docs.some((d) => !finished(d)) && Date.now() < deadline) {
        await sleep(POLL_MS);
        docs = await Promise.all(docs.map((d) => (finished(d) ? d : api.document(d.id))));
        setItems(docs);
      }
      if (docs.some((d) => !finished(d))) onError('Reading is taking longer than usual. It continues on the server — press ↻ in a minute.');
      await onDone(docs.filter((d) => d.status === 'completed'));
    } catch (err) {
      onError(messageOf(err));
    } finally {
      setBusy(false);
      // Lets the same file be chosen again.
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="upload">
      <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => upload(e.target.files)} />
      <button
        type="button"
        className={`dropzone compact${over ? ' over' : ''}`}
        disabled={disabled || busy}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}
      >
        <span className="drop-icon"><UploadIcon size={14} /></span>
        <span className="strong">{busy ? 'Reading…' : label}</span>
        {!busy && <span className="muted small">or drop it here</span>}
      </button>
      {busy && <div className="bar sweep"><span /></div>}
      {items.map((d) => (
        <div key={d.id} className={`small ${d.status === 'failed' ? 'bad' : d.status === 'completed' ? '' : 'muted'}`}>
          {d.status === 'completed' ? '✓' : d.status === 'failed' ? '✗' : '…'} {d.fileName}
          {' — '}
          {d.status === 'completed'
            ? `read${KIND[d.docType ?? ''] ? ` as ${KIND[d.docType ?? '']}` : ''}${d.ipNo ? `, IP ${d.ipNo}` : ''}${d.fileKept ? '' : ' · PDF not kept'}`
            : d.status === 'failed'
              ? d.failureReason || 'could not be read'
              : 'reading (scanned pages take longer)'}
        </div>
      ))}
      {refused.map((r) => <div key={r} className="small bad">✗ {r}</div>)}
    </div>
  );
}

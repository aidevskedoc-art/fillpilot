// Small display helpers shared by both apps.
import { DocumentStatus } from './api-types';

export type TagSeverity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

export function statusSeverity(status: DocumentStatus): TagSeverity {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'uploaded':
      return 'secondary';
    default:
      return 'info';
  }
}

export function statusLabel(status: DocumentStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Confidence (0..1) → "98%". */
export function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

export function confidenceSeverity(value: number): TagSeverity {
  if (value >= 0.85) return 'success';
  if (value >= 0.6) return 'warn';
  return 'danger';
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const IN_PROGRESS: DocumentStatus[] = ['uploaded', 'processing', 'extracting', 'validating'];

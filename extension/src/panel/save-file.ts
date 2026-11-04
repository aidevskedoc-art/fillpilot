// Saves a file through the browser's own download (the usual Downloads folder).
// Works from the side panel without the "downloads" permission.
export function saveFile(file: Blob, name: string): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

/** Base64 (as the server sends a file) → a Blob of that type. */
export function blobFromBase64(base64: string, type: string): Blob {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return new Blob([bytes], { type });
}

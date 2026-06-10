export function cloneObject(item: any) {
  return JSON.parse(JSON.stringify(item));
}

// Escape user-supplied text before interpolating it into popup HTML (node names, error strings).
// MapLibre popups render with setHTML, so unescaped names would be a stored-XSS vector.
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

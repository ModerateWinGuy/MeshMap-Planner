// Thin wrapper around the GoatCounter beacon loaded in index.html (privacy-friendly, cookieless —
// see https://www.goatcounter.com). The beacon no-ops on localhost and skips entirely if blocked or
// not configured, so call sites never need to guard for that — just call trackEvent().
declare global {
  interface Window {
    goatcounter?: {
      count: (opts: { path: string; title?: string; event?: boolean }) => void;
    };
  }
}

export function trackEvent(path: string, title?: string) {
  window.goatcounter?.count({ path, title, event: true });
}

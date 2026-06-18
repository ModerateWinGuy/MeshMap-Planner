import { ref, onBeforeUnmount } from 'vue';
import { buildShareUrl, type SharePayload } from './utils.ts';

// Copy a share link to the clipboard with a brief "copied" flag, shared by every share affordance
// (the navbar dropdown, the folder-header icon, the profile strip's link button).
export function useShareLink() {
  const copied = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  // navigator.clipboard needs a secure context (https / localhost — both hold for this app); fall back
  // to a hidden textarea + execCommand, then a prompt, so a copy still works in odd contexts.
  async function copyText(text: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      // fall through to the legacy path
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch {
      prompt('Copy this share link:', text);
    }
  }

  // payload may be a value or a builder evaluated now (so it captures the current selection/coords);
  // a null payload (or builder returning null) cancels.
  async function share(payload: SharePayload | (() => SharePayload | null) | null) {
    const resolved = typeof payload === 'function' ? payload() : payload;
    if (!resolved) {
      return;
    }
    await copyText(buildShareUrl(resolved));
    copied.value = true;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      copied.value = false;
    }, 1500);
  }

  onBeforeUnmount(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });

  return { copied, share };
}

import { useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    emit();
  });
}

export function isStandalone(): boolean {
  return (
    installed ||
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * A chat or social app's built-in browser (Instagram, Facebook, Messenger, LINE, WeChat, TikTok, Snapchat…).
 * Its storage is its own, so saves added there don't show up in your Magpie.
 */
export function isInAppBrowser(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /\b(?:FBAN|FBAV|FB_IAB|FBIOS|Instagram|Line\/|MicroMessenger|Snapchat|musical_ly|BytedanceWebview|TikTok|Twitter|LinkedInApp|GSA\/)/i.test(ua);
}

/**
 * Any app's built-in browser or web view (social apps, chat apps, and apps that open links inside themselves).
 * Storage there belongs to that app and can be wiped when it closes, so saves made there may not be kept.
 */
export function isEmbeddedBrowser(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  if (isInAppBrowser(ua)) return true;
  // Android System WebView marks itself with "; wv)".
  if (/; wv\)/.test(ua)) return true;
  // On iOS, Safari, Chrome and Firefox all carry "Safari/"; app web views don't. Home Screen apps don't either.
  return /iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua) && typeof window !== 'undefined' && !isStandalone();
}

export function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export interface InstallState {
  /** The browser offered a one-tap install prompt. */
  canPrompt: boolean;
  standalone: boolean;
  ios: boolean;
}

let snapshot: InstallState | null = null;
function getState(): InstallState {
  const next = { canPrompt: !!deferred, standalone: isStandalone(), ios: isIos() };
  if (!snapshot || snapshot.canPrompt !== next.canPrompt || snapshot.standalone !== next.standalone) snapshot = next;
  return snapshot;
}

export function useInstall(): InstallState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getState,
    getState,
  );
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  await e.prompt();
  const { outcome } = await e.userChoice;
  emit();
  return outcome === 'accepted';
}

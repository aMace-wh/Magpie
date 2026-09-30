import { useSyncExternalStore } from 'react';

/** Per-device preferences. Library data lives in IndexedDB, not here. */
export interface Settings {
  previews: boolean;
  theme: 'system' | 'light' | 'dark';
  onboarded: boolean;
  /** Shown to friends when you share ("From Sam"). */
  name: string;
}

const KEY = 'magpie:settings';
const DEFAULTS: Settings = { previews: true, theme: 'system', onboarded: false, name: '' };

let current: Settings = load();
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function getSettings(): Settings {
  return current;
}

export function setSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode — keep in memory only */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}

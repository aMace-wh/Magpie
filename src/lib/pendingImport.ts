import { useSyncExternalStore } from 'react';

/**
 * A share file waiting to be previewed on "#/import-file": picked in Settings or opened with the
 * installed app. Files can't go in a URL, so the route reads it from here. It stays until the
 * next file replaces it, so back / forward to that page keeps working.
 */

let pending: File | undefined;
const listeners = new Set<() => void>();

export function setPendingImport(file: File | undefined): void {
  pending = file;
  listeners.forEach((l) => l());
}

export function getPendingImport(): File | undefined {
  return pending;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingImport(): File | undefined {
  return useSyncExternalStore(subscribe, getPendingImport, getPendingImport);
}

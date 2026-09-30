/** Uses the native share sheet when available, otherwise copies the link. Returns what happened. */
export async function shareLink(data: { title: string; text?: string; url: string }): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  // An empty url makes some browsers reject the whole share, so leave it out.
  const shareData: ShareData = data.url ? data : { title: data.title, text: data.text || data.title };
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share(shareData);
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyText(data.url || data.text || data.title)) ? 'copied' : 'failed';
}

/** Copies text to the clipboard. False when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Can the native share sheet take these files? */
export function canShareFiles(files: File[]): boolean {
  try {
    return typeof navigator !== 'undefined' && !!navigator.share && !!navigator.canShare && navigator.canShare({ files });
  } catch {
    return false;
  }
}

/** Shares files through the native share sheet. 'unsupported' when the browser can't share them. */
export async function shareFiles(data: { files: File[]; title?: string; text?: string }): Promise<'shared' | 'cancelled' | 'unsupported' | 'failed'> {
  if (!canShareFiles(data.files)) return 'unsupported';
  try {
    await navigator.share(data);
    return 'shared';
  } catch (e) {
    return (e as DOMException).name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

/** Saves a file to the device (browser download). */
export function downloadFile(file: File | Blob, name = file instanceof File ? file.name : 'download'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Phones and tablets, where app-only share links (e.g. Messenger) can work. */
export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof uaData?.mobile === 'boolean' && uaData.mobile) return true;
  // iPadOS reports itself as a Mac, but has touch.
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

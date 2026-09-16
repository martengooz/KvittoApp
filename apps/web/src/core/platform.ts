/**
 * Platform capability checks and the small native integrations worth using.
 *
 * Everything here is progressive: each helper reports whether it is available
 * so callers can hide UI that would do nothing, and nothing throws on a
 * platform that lacks the API.
 */

/** True when running as an installed Home Screen app rather than in a tab. */
export function isStandalone(): boolean {
  // iOS predates the standard and still only sets the non-standard property.
  const legacy = (navigator as unknown as { standalone?: boolean }).standalone;
  return legacy === true || window.matchMedia('(display-mode: standalone)').matches;
}

/** True for iPhone/iPad, including iPadOS reporting itself as a Mac. */
export function isIos(): boolean {
  const agent = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(agent)) return true;
  // iPadOS 13+ claims to be a Mac; a touch-capable "Mac" is really an iPad.
  return /Macintosh/.test(agent) && navigator.maxTouchPoints > 1;
}

/** True for any WebKit-based browser, which is every browser on iOS. */
export function isWebKit(): boolean {
  return /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);
}

export type HapticKind = 'selection' | 'impact' | 'success' | 'warning' | 'error';

const HAPTIC_PATTERNS: Record<HapticKind, number | number[]> = {
  selection: 8,
  impact: 14,
  success: [12, 60, 12],
  warning: [18, 70, 18],
  error: [24, 60, 24, 60, 24],
};

/**
 * Fires a haptic tap where the platform supports it.
 *
 * Safari on iOS does not implement the Vibration API, so this is a no-op there
 * — deliberately, rather than reaching for one of the hacks that fake it. It
 * still works on Android, and costs nothing where it does not.
 */
export function haptic(kind: HapticKind = 'selection'): void {
  if (typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(HAPTIC_PATTERNS[kind]);
  } catch {
    // Some browsers throw when vibration is blocked by a permissions policy.
  }
}

export interface ShareContent {
  title?: string;
  text?: string;
  url?: string;
  files?: File[];
}

/** True when {@link share} can actually present the system share sheet. */
export function canShare(content: ShareContent = {}): boolean {
  if (typeof navigator.share !== 'function') return false;
  if (content.files?.length) {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: content.files });
  }
  return true;
}

export type ShareResult = 'shared' | 'cancelled' | 'unsupported' | 'failed';

/** Opens the system share sheet. Returns what happened, rather than throwing. */
export async function share(content: ShareContent): Promise<ShareResult> {
  if (!canShare(content)) return 'unsupported';
  try {
    await navigator.share(content);
    return 'shared';
  } catch (error) {
    // Dismissing the sheet rejects with AbortError; that is not a failure.
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    console.warn('Share failed', error);
    return 'failed';
  }
}

/**
 * Whether Safari will render `<input type="checkbox" switch>` as the real iOS
 * switch. Used to pick between the native control and the CSS stand-in.
 *
 * Feature-detected by setting the attribute and asking Safari whether it
 * changed the control's intrinsic width — there is no `CSS.supports` query for
 * it, and a user-agent sniff would go stale.
 */
let nativeSwitchSupport: boolean | null = null;

export function supportsNativeSwitch(): boolean {
  if (nativeSwitchSupport !== null) return nativeSwitchSupport;

  const probe = document.createElement('input');
  probe.type = 'checkbox';
  // A browser that does not know the attribute simply ignores it.
  probe.setAttribute('switch', '');
  probe.style.position = 'absolute';
  probe.style.opacity = '0';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);

  // An iOS switch is a wide pill; a plain checkbox is roughly square.
  const { width, height } = probe.getBoundingClientRect();
  nativeSwitchSupport = width > height * 1.5;
  probe.remove();

  return nativeSwitchSupport;
}

/**
 * Estimated storage use, for the Settings screen. Returns `null` where the
 * Storage API is unavailable (Safari before 17, and some private modes).
 */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  if (estimate.usage === undefined || estimate.quota === undefined) return null;
  return { usage: estimate.usage, quota: estimate.quota };
}

/**
 * Asks the browser to make storage persistent, so receipts survive eviction
 * under storage pressure. Chrome grants this silently for installed PWAs;
 * Firefox prompts. Returns whether storage is persistent afterwards.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

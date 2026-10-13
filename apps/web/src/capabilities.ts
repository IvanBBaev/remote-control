import { probeWebCrypto } from '@remote-control/crypto';

/**
 * What the platform offers, as plain facts. Collected once at start-up by
 * {@link readBrowserEnvironment}; tests build it directly.
 */
export interface CapabilityFacts {
  /** Running as an installed app (Home Screen / WebAPK), not in a browser tab. */
  readonly standalone: boolean;
  /** `PushManager` exists. iOS exposes it only to Home Screen apps (05 F1). */
  readonly push: boolean;
  /** `PublicKeyCredential` exists: passkeys can be created and asserted (D8). */
  readonly webAuthn: boolean;
  /** WebCrypto runs every algorithm `packages/crypto` needs, X25519 included (D3). */
  readonly webCrypto: boolean;
}

/** A capability whose absence blocks the app. */
export type MissingCapability = 'push' | 'webAuthn' | 'webCrypto';

/**
 * - `supported`: everything is there.
 * - `install-required`: push appears only once the app is installed (iOS in a Safari
 *   tab); the app shows "install first".
 * - `unsupported`: the browser is below the platform floor (D3: iOS 17+, Chrome
 *   Android 133+); the app shows "update your browser".
 */
export type CapabilityVerdict = 'supported' | 'install-required' | 'unsupported';

export interface CapabilityReport extends CapabilityFacts {
  readonly verdict: CapabilityVerdict;
  /** Blocking capabilities that are absent; empty unless `unsupported`. */
  readonly missing: readonly MissingCapability[];
}

/** Pure decision over the facts; the table in `capabilities.test.ts` covers all 16 inputs. */
export function evaluateCapabilities(facts: CapabilityFacts): CapabilityReport {
  const missing: MissingCapability[] = [];
  if (!facts.webAuthn) missing.push('webAuthn');
  if (!facts.webCrypto) missing.push('webCrypto');
  // Without push in a tab, installing may add it (iOS); once installed nothing will.
  if (!facts.push && facts.standalone) missing.push('push');
  if (missing.length > 0) return { ...facts, verdict: 'unsupported', missing };
  if (!facts.push) return { ...facts, verdict: 'install-required', missing };
  return { ...facts, verdict: 'supported', missing };
}

/** The slice of `window` the probe reads; injected so tests need no real browser. */
export interface BrowserEnvironment {
  readonly navigator: { readonly standalone?: boolean };
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
  readonly PushManager?: unknown;
  readonly PublicKeyCredential?: unknown;
}

/** Reads the probe's slice of a real `window`. */
export function readBrowserEnvironment(win: Window): BrowserEnvironment {
  // `navigator.standalone` is iOS-only and absent from the DOM typings.
  const standalone = Reflect.get(win.navigator, 'standalone') === true;
  return {
    navigator: { standalone },
    // Older engines and jsdom lack `matchMedia`, whatever the DOM typings say.
    matchMedia: 'matchMedia' in win ? (query) => win.matchMedia(query) : undefined,
    PushManager: 'PushManager' in win ? win.PushManager : undefined,
    PublicKeyCredential: 'PublicKeyCredential' in win ? win.PublicKeyCredential : undefined,
  };
}

/**
 * Installed-app detection. iOS reports `navigator.standalone`; it also reports an
 * installed `display: standalone` app as `display-mode: fullscreen` (05 F26), so both
 * media queries count.
 */
export function isStandalone(env: BrowserEnvironment): boolean {
  if (env.navigator.standalone === true) return true;
  const query = env.matchMedia;
  if (query === undefined) return false;
  return query('(display-mode: standalone)').matches || query('(display-mode: fullscreen)').matches;
}

/** Answers whether WebCrypto is complete enough for `packages/crypto`. */
export type WebCryptoCheck = () => Promise<boolean>;

/** Default check: `packages/crypto`'s own probe, which runs the RFC 7748 X25519 vector. */
export const defaultWebCryptoCheck: WebCryptoCheck = async () => (await probeWebCrypto()).ok;

/** Collects the facts from a browser environment and evaluates them. */
export async function probeCapabilities(
  env: BrowserEnvironment,
  checkWebCrypto: WebCryptoCheck = defaultWebCryptoCheck,
): Promise<CapabilityReport> {
  return evaluateCapabilities({
    standalone: isStandalone(env),
    push: env.PushManager !== undefined,
    webAuthn: env.PublicKeyCredential !== undefined,
    webCrypto: await checkWebCrypto(),
  });
}

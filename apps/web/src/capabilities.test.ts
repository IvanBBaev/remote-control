import { describe, expect, it, vi } from 'vitest';

import {
  defaultWebCryptoCheck,
  evaluateCapabilities,
  isStandalone,
  probeCapabilities,
  readBrowserEnvironment,
} from './capabilities.js';
import type {
  BrowserEnvironment,
  CapabilityFacts,
  CapabilityVerdict,
  MissingCapability,
} from './capabilities.js';

type Row = [
  standalone: boolean,
  push: boolean,
  webAuthn: boolean,
  webCrypto: boolean,
  verdict: CapabilityVerdict,
  missing: MissingCapability[],
];

// Every combination of the four facts (2^4 = 16 rows).
const TABLE: Row[] = [
  // In a browser tab.
  [false, true, true, true, 'supported', []],
  [false, false, true, true, 'install-required', []],
  [false, true, false, true, 'unsupported', ['webAuthn']],
  [false, false, false, true, 'unsupported', ['webAuthn']],
  [false, true, true, false, 'unsupported', ['webCrypto']],
  [false, false, true, false, 'unsupported', ['webCrypto']],
  [false, true, false, false, 'unsupported', ['webAuthn', 'webCrypto']],
  [false, false, false, false, 'unsupported', ['webAuthn', 'webCrypto']],
  // Installed: missing push can no longer be fixed by installing.
  [true, true, true, true, 'supported', []],
  [true, false, true, true, 'unsupported', ['push']],
  [true, true, false, true, 'unsupported', ['webAuthn']],
  [true, false, false, true, 'unsupported', ['webAuthn', 'push']],
  [true, true, true, false, 'unsupported', ['webCrypto']],
  [true, false, true, false, 'unsupported', ['webCrypto', 'push']],
  [true, true, false, false, 'unsupported', ['webAuthn', 'webCrypto']],
  [true, false, false, false, 'unsupported', ['webAuthn', 'webCrypto', 'push']],
];

describe('evaluateCapabilities', () => {
  it('covers all 16 combinations exactly once', () => {
    const keys = new Set(TABLE.map((row) => row.slice(0, 4).join()));
    expect(keys.size).toBe(16);
  });

  it.each(TABLE)(
    'standalone=%s push=%s webAuthn=%s webCrypto=%s → %s %j',
    (standalone, push, webAuthn, webCrypto, verdict, missing) => {
      const facts: CapabilityFacts = { standalone, push, webAuthn, webCrypto };
      expect(evaluateCapabilities(facts)).toEqual({ ...facts, verdict, missing });
    },
  );
});

function env(overrides: Partial<BrowserEnvironment> = {}): BrowserEnvironment {
  return { navigator: {}, ...overrides };
}

function mediaQueries(matching: string[]): BrowserEnvironment['matchMedia'] {
  return (query) => ({ matches: matching.includes(query) });
}

describe('isStandalone', () => {
  it.each<[string, BrowserEnvironment, boolean]>([
    ['no signals', env(), false],
    ['matchMedia without a match', env({ matchMedia: mediaQueries([]) }), false],
    ['iOS navigator.standalone', env({ navigator: { standalone: true } }), true],
    ['navigator.standalone false', env({ navigator: { standalone: false } }), false],
    [
      'display-mode: standalone',
      env({ matchMedia: mediaQueries(['(display-mode: standalone)']) }),
      true,
    ],
    [
      'display-mode: fullscreen (installed iOS app, 05 F26)',
      env({ matchMedia: mediaQueries(['(display-mode: fullscreen)']) }),
      true,
    ],
  ])('%s → %s', (_name, environment, expected) => {
    expect(isStandalone(environment)).toBe(expected);
  });
});

describe('probeCapabilities', () => {
  it('reads the facts from the environment', async () => {
    const report = await probeCapabilities(
      env({
        navigator: { standalone: true },
        PushManager: class {},
        PublicKeyCredential: class {},
      }),
      () => Promise.resolve(true),
    );
    expect(report).toEqual({
      standalone: true,
      push: true,
      webAuthn: true,
      webCrypto: true,
      verdict: 'supported',
      missing: [],
    });
  });

  it('reports an iOS Safari tab as install-required', async () => {
    const report = await probeCapabilities(env({ PublicKeyCredential: class {} }), () =>
      Promise.resolve(true),
    );
    expect(report.verdict).toBe('install-required');
  });

  it('uses the WebCrypto check it is given', async () => {
    const check = vi.fn(() => Promise.resolve(false));
    const report = await probeCapabilities(
      env({ PushManager: class {}, PublicKeyCredential: class {} }),
      check,
    );
    expect(check).toHaveBeenCalledOnce();
    expect(report.missing).toEqual(['webCrypto']);
  });

  it('defaults to the crypto package probe', async () => {
    const report = await probeCapabilities(env());
    expect(report.webCrypto).toBe(await defaultWebCryptoCheck());
  });
});

describe('readBrowserEnvironment', () => {
  it('reads the globals the probe needs from a window', () => {
    const matchMedia = vi.fn(() => ({ matches: true }));
    const PushManager = class {};
    const PublicKeyCredential = class {};
    const win = {
      navigator: { standalone: true },
      matchMedia,
      PushManager,
      PublicKeyCredential,
    } as unknown as Window;
    const environment = readBrowserEnvironment(win);
    expect(environment.navigator.standalone).toBe(true);
    expect(environment.PushManager).toBe(PushManager);
    expect(environment.PublicKeyCredential).toBe(PublicKeyCredential);
    expect(environment.matchMedia?.('(display-mode: standalone)').matches).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(display-mode: standalone)');
  });

  it('leaves absent APIs undefined', () => {
    const environment = readBrowserEnvironment({ navigator: {} } as unknown as Window);
    expect(environment).toEqual({
      navigator: { standalone: false },
      matchMedia: undefined,
      PushManager: undefined,
      PublicKeyCredential: undefined,
    });
  });
});

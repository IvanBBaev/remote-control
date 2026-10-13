import type { CDPSession, Page } from '@playwright/test';

export interface VirtualAuthenticator {
  readonly cdp: CDPSession;
  readonly authenticatorId: string;
  /** Every credential the authenticator holds (one per registered account). */
  credentials(): Promise<readonly { readonly credentialId: string; readonly signCount: number }[]>;
}

/**
 * A platform passkey with user verification (A1, 07 §5.10): a CTAP2 internal
 * authenticator through the Chrome DevTools Protocol that holds resident keys and
 * reports every ceremony as user-verified, so Allow and Start get their UV flag.
 */
export async function withVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    cdp,
    authenticatorId,
    async credentials() {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      return credentials;
    },
  };
}

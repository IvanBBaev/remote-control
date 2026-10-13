import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';

import { AppStateProvider } from './app-state.js';
import type { PlatformActions } from './app-state.js';
import { createAuthStore } from './auth/auth-store.js';
import type { AuthStore } from './auth/auth-store.js';
import type { RelayApi } from './auth/relay-api.js';
import { fakeRelay } from './auth/test-credentials.js';
import type { OnboardingState } from './onboarding.js';
import { AppRoutes } from './routes.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  readonly container: HTMLElement;
  heading(): string | undefined;
  button(name: string): HTMLButtonElement;
  unmount(): void;
}

function LocationProbe({ onChange }: { onChange: (path: string) => void }) {
  onChange(useLocation().pathname);
  return null;
}

/** Mounts `children` in jsdom with `act`; no testing-library needed. */
export async function render(children: ReactNode): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(children);
    await Promise.resolve();
  });
  return {
    container,
    heading: () => container.querySelector('h1')?.textContent ?? undefined,
    button(name) {
      const found = [...container.querySelectorAll('button')].find((b) => b.textContent === name);
      if (found === undefined) throw new Error(`no button "${name}"`);
      return found;
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const noPlatform: PlatformActions = {
  requestNotificationPermission: () => Promise.resolve('granted'),
};

export interface RenderedApp extends Rendered {
  /** Current router path, as `useLocation()` sees it. */
  path(): string;
}

export interface RenderAppOptions {
  readonly platform?: PlatformActions;
  readonly relay?: RelayApi;
  /** Defaults to a store that is signed in exactly when `state.signedIn` is. */
  readonly auth?: AuthStore;
}

/** Mounts the full route table at `path` with the given onboarding state. */
export async function renderApp(
  path: string,
  state: OnboardingState,
  { platform = noPlatform, relay = fakeRelay(), auth }: RenderAppOptions = {},
): Promise<RenderedApp> {
  const store =
    auth ??
    createAuthStore({
      api: relay,
      initial: state.signedIn
        ? { status: 'signed-in', userId: 'user-1' }
        : { status: 'signed-out' },
    });
  let current = path;
  const rendered = await render(
    <MemoryRouter initialEntries={[path]}>
      <AppStateProvider initialState={state} platform={platform} auth={store} relay={relay}>
        <AppRoutes />
        <LocationProbe
          onChange={(p) => {
            current = p;
          }}
        />
      </AppStateProvider>
    </MemoryRouter>,
  );
  return { ...rendered, path: () => current };
}

/** Lets every queued promise and timer-free continuation run inside `act`. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Clicks `element` inside `act` and lets pending promises settle. */
export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settle();
}

/** Types `value` into an input the way React sees it (native setter + `input` event). */
export async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    // React tracks the instance's own value; the prototype setter bypasses that tracker.
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

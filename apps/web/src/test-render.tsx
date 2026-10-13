import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';

import { AppStateProvider } from './app-state.js';
import type { PlatformActions } from './app-state.js';
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

/** Mounts the full route table at `path` with the given onboarding state. */
export async function renderApp(
  path: string,
  state: OnboardingState,
  platform: PlatformActions = noPlatform,
): Promise<RenderedApp> {
  let current = path;
  const rendered = await render(
    <MemoryRouter initialEntries={[path]}>
      <AppStateProvider initialState={state} platform={platform}>
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

/** Clicks `element` inside `act` and lets pending promises settle. */
export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

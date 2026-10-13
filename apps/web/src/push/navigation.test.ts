import { describe, expect, it, vi } from 'vitest';

import { listenForNavigation } from './navigation.js';
import type { NavigationSource } from './navigation.js';

describe('service worker navigation', () => {
  it('follows navigate messages to same-origin paths only', () => {
    const source = new EventTarget() as EventTarget & NavigationSource;
    const navigate = vi.fn();
    const stop = listenForNavigation(source, navigate);
    const post = (data: unknown) => source.dispatchEvent(new MessageEvent('message', { data }));
    post({ t: 'navigate', url: '/requests/r-1' });
    post({ t: 'navigate', url: '//evil.example/' });
    post({ t: 'navigate', url: 'https://evil.example/' });
    post({ t: 'navigate', url: 42 });
    post({ t: 'other', url: '/sessions' });
    post(null);
    post('navigate');
    expect(navigate.mock.calls).toEqual([['/requests/r-1']]);
    stop();
    post({ t: 'navigate', url: '/sessions' });
    expect(navigate).toHaveBeenCalledOnce();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

const bootstrap = vi.fn(() => Promise.resolve());
vi.mock('./bootstrap.js', () => ({ bootstrap }));
vi.mock('./styles.css', () => ({}));

describe('main', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.resetModules();
    bootstrap.mockClear();
  });

  it('bootstraps into #root', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    await import('./main.js');
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ container: root }));
  });

  it('passes the Notification API when the browser has one', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    const api = { permission: 'default', requestPermission: vi.fn() };
    vi.stubGlobal('Notification', api);
    try {
      await import('./main.js');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ notifications: api }));
  });

  it('fails loudly without #root', async () => {
    await expect(import('./main.js')).rejects.toThrow('#root is missing');
  });
});

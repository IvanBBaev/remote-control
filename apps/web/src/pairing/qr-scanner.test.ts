import { describe, expect, it, vi } from 'vitest';

import { cameraQrScanner, createCameraQrScanner, QrScanError } from './qr-scanner.js';
import type { QrDetector } from './qr-scanner.js';

function fakeCamera() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn((_: MediaStreamConstraints) => Promise.resolve(stream));
  const play = vi.fn(() => Promise.resolve());
  const video = { muted: false, playsInline: false, srcObject: null, play };
  return {
    track,
    stream,
    getUserMedia,
    play,
    video,
    element: video as unknown as HTMLVideoElement,
  };
}

/** Answers each `detect` call with the next result; the last one repeats. */
function fakeDetector(
  ...results: (readonly string[] | DOMException)[]
): QrDetector & { calls: number } {
  const detector = {
    calls: 0,
    detect() {
      const result = results[Math.min(detector.calls, results.length - 1)]!;
      detector.calls += 1;
      return result instanceof DOMException
        ? Promise.reject(result)
        : Promise.resolve(result.map((rawValue) => ({ rawValue })));
    },
  };
  return detector;
}

describe('camera QR scanner', () => {
  it('shows the back camera and returns the first QR text, then releases the camera', async () => {
    const camera = fakeCamera();
    const detector = fakeDetector(
      new DOMException('no frame yet', 'InvalidStateError'),
      [],
      [''],
      ['rc1:relay.example:id:key'],
    );
    const scanner = createCameraQrScanner({
      mediaDevices: { getUserMedia: camera.getUserMedia },
      loadDetector: () => Promise.resolve(detector),
      intervalMs: 0,
    });
    const text = await scanner.scan(camera.element, new AbortController().signal);
    expect(text).toBe('rc1:relay.example:id:key');
    expect(detector.calls).toBe(4);
    expect(camera.getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'environment' },
      audio: false,
    });
    expect(camera.video).toMatchObject({ muted: true, playsInline: true, srcObject: null });
    expect(camera.play).toHaveBeenCalledOnce();
    expect(camera.track.stop).toHaveBeenCalledOnce();
  });

  it.each([
    [new DOMException('blocked', 'NotAllowedError'), 'denied'],
    [new DOMException('insecure', 'SecurityError'), 'denied'],
    [new DOMException('no camera', 'NotFoundError'), 'unavailable'],
  ])('reports a refused camera: %s', async (error, reason) => {
    const scanner = createCameraQrScanner({
      mediaDevices: { getUserMedia: () => Promise.reject(error) },
      loadDetector: () => Promise.resolve(fakeDetector([])),
    });
    const failure = scanner.scan(fakeCamera().element, new AbortController().signal);
    await expect(failure).rejects.toBeInstanceOf(QrScanError);
    await expect(failure).rejects.toMatchObject({ reason });
  });

  it('reports a decoder that fails to load and still releases the camera', async () => {
    const camera = fakeCamera();
    const scanner = createCameraQrScanner({
      mediaDevices: { getUserMedia: camera.getUserMedia },
      loadDetector: () => Promise.reject(new Error('wasm')),
    });
    await expect(scanner.scan(camera.element, new AbortController().signal)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(camera.track.stop).toHaveBeenCalledOnce();
  });

  it('stops scanning and releases the camera when aborted', async () => {
    const camera = fakeCamera();
    const detector = fakeDetector([]);
    const scanner = createCameraQrScanner({
      mediaDevices: { getUserMedia: camera.getUserMedia },
      loadDetector: () => Promise.resolve(detector),
      intervalMs: 60_000,
    });
    const controller = new AbortController();
    const scan = scanner.scan(camera.element, controller.signal);
    await vi.waitFor(() => {
      expect(detector.calls).toBe(1);
    });
    controller.abort(new Error('closed'));
    await expect(scan).rejects.toThrow('closed');
    expect(camera.track.stop).toHaveBeenCalledOnce();
    expect(camera.video.srcObject).toBeNull();
  });

  it('is only offered where the browser has a camera API', () => {
    expect(cameraQrScanner(undefined)).toBeUndefined();
    expect(cameraQrScanner({})).toBeUndefined();
    expect(cameraQrScanner({ getUserMedia: () => Promise.reject(new Error('x')) })).toBeDefined();
  });
});

import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

/** Reads the pairing QR with the back camera (M2-04); the typed code stays available (D6). */
export interface QrScanner {
  /**
   * Shows the camera in `video` and resolves with the first QR text it sees. Aborting
   * `signal` stops the scan; the camera is released either way.
   */
  scan(video: HTMLVideoElement, signal: AbortSignal): Promise<string>;
}

/** The camera could not be used; `reason` picks the message for the user. */
export class QrScanError extends Error {
  constructor(
    readonly reason: 'denied' | 'unavailable',
    options?: ErrorOptions,
  ) {
    super(`QR scan failed: ${reason}`, options);
    this.name = 'QrScanError';
  }
}

/** The slice of `BarcodeDetector` the scanner uses. */
export interface QrDetector {
  detect(source: HTMLVideoElement): Promise<readonly { readonly rawValue: string }[]>;
}

export interface CameraQrScannerOptions {
  readonly mediaDevices: Pick<MediaDevices, 'getUserMedia'>;
  /** Defaults to the zxing ponyfill with the self-hosted wasm. */
  readonly loadDetector?: () => Promise<QrDetector>;
  /** Between two looks at the video. */
  readonly intervalMs?: number;
}

const SCAN_INTERVAL_MS = 250;

/**
 * Always the zxing ponyfill, never the native detector: it reads the inverted QR a dark
 * terminal draws (`tryInvert`), and behaves the same on iOS and Android. The wasm comes
 * from this origin, not the library's default CDN, and only once the user opens the camera.
 */
async function loadZxingDetector(): Promise<QrDetector> {
  const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill');
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? new URL(wasmUrl, document.baseURI).href : prefix + path,
    },
  });
  return new BarcodeDetector({ formats: ['qr_code'] });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason as Error);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function cameraFailure(error: unknown): QrScanError {
  const denied =
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError');
  return new QrScanError(denied ? 'denied' : 'unavailable', { cause: error });
}

/** No frame decoded yet: the ponyfill refuses a video without data. */
const notReady = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'InvalidStateError';

export function createCameraQrScanner({
  mediaDevices,
  loadDetector = loadZxingDetector,
  intervalMs = SCAN_INTERVAL_MS,
}: CameraQrScannerOptions): QrScanner {
  return {
    async scan(video, signal) {
      // The decoder loads while the user answers the camera prompt.
      const detector = loadDetector();
      detector.catch(() => undefined);
      let stream: MediaStream;
      try {
        stream = await mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch (error) {
        throw cameraFailure(error);
      }
      try {
        signal.throwIfAborted();
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        let reader: QrDetector;
        try {
          await video.play();
          reader = await detector;
        } catch (error) {
          signal.throwIfAborted();
          throw cameraFailure(error);
        }
        for (;;) {
          signal.throwIfAborted();
          let found: string | undefined;
          try {
            found = (await reader.detect(video)).find((code) => code.rawValue !== '')?.rawValue;
          } catch (error) {
            if (!notReady(error)) throw cameraFailure(error);
          }
          signal.throwIfAborted();
          if (found !== undefined) return found;
          await pause(intervalMs, signal);
        }
      } finally {
        for (const track of stream.getTracks()) track.stop();
        video.srcObject = null;
      }
    },
  };
}

/** The scanner where the browser has a camera API; `undefined` hides the scan button. */
export function cameraQrScanner(
  mediaDevices: Partial<Pick<MediaDevices, 'getUserMedia'>> | undefined,
): QrScanner | undefined {
  const getUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);
  return getUserMedia === undefined
    ? undefined
    : createCameraQrScanner({ mediaDevices: { getUserMedia } });
}

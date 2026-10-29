/**
 * Single-file build: the engine runs on the page itself. Browsers refuse to
 * start Blob/data: workers for pages opened from file://, and a double-clicked
 * blueexif.html must simply work. vite.config.ts aliases './workerFactory' to
 * this module when building with `--mode single`.
 */
import { handleRequest, type WorkerRequest, type WorkerResponse } from './engineHost';

/** The subset of the Worker interface engineClient uses, served in-page. */
class InPageEngine {
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;

  postMessage(req: WorkerRequest): void {
    // Deliver asynchronously, like a worker, so callers never re-enter.
    setTimeout(async () => {
      const res = await handleRequest(req);
      this.onmessage?.(new MessageEvent('message', { data: res }));
    }, 0);
  }

  terminate(): void {}
}

export function createEngineWorker(): Worker {
  return new InPageEngine() as unknown as Worker;
}

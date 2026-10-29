/** Starts the metadata engine worker from its own bundled file. */
export function createEngineWorker(): Worker {
  return new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'blueexif-engine' });
}

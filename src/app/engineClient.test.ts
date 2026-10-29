/**
 * Engine RPC: one request at a time, each with a deadline; a worker that stops
 * answering (a parser stuck on a crafted file) or crashes is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest, WorkerResponse } from './engineHost';

const { FakeWorker } = vi.hoisted(() => {
  class FakeWorker {
    static all: FakeWorker[] = [];
    onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null = null;
    onerror: ((ev: ErrorEvent) => void) | null = null;
    posted: WorkerRequest[] = [];
    terminated = false;
    constructor() {
      FakeWorker.all.push(this);
    }
    postMessage(req: WorkerRequest) {
      this.posted.push(req);
    }
    terminate() {
      this.terminated = true;
    }
    reply(result: unknown, id = this.posted[this.posted.length - 1].id) {
      this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent<WorkerResponse>);
    }
  }
  return { FakeWorker };
});

vi.mock('./workerFactory', () => ({ createEngineWorker: () => new FakeWorker() }));

const blob = (size: number) => ({ size }) as Blob;

describe('engine client', () => {
  let client: typeof import('./engineClient');
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeWorker.all = [];
    client = await import('./engineClient');
  });
  afterEach(() => vi.useRealTimers());

  it('runs one request at a time, so waiting never counts against a deadline', async () => {
    const a = client.engine.read(blob(10), 'a.jpg');
    const b = client.engine.read(blob(10), 'b.jpg');
    const [w] = FakeWorker.all;
    expect(w.posted.map((r) => r.op === 'read' && r.name)).toEqual(['a.jpg']);
    w.reply('A');
    await expect(a).resolves.toBe('A');
    expect(w.posted.map((r) => r.op === 'read' && r.name)).toEqual(['a.jpg', 'b.jpg']);
    w.reply('B');
    await expect(b).resolves.toBe('B');
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('replaces a worker that stops answering', async () => {
    const stuck = client.engine.read(blob(1000), 'crafted.svg');
    const next = client.engine.read(blob(10), 'next.jpg');
    const [w1] = FakeWorker.all;
    const failed = expect(stuck).rejects.toThrow(/took too long to process/);
    vi.advanceTimersByTime(29_000);
    expect(w1.terminated).toBe(false);
    vi.advanceTimersByTime(2_000);
    await failed;
    expect(w1.terminated).toBe(true);
    const w2 = FakeWorker.all[1];
    expect(w2.posted.map((r) => r.op === 'read' && r.name)).toEqual(['next.jpg']);
    w1.reply('late', w1.posted[0].id); // the old worker's answer arrives after all: ignored
    w2.reply('ok');
    await expect(next).resolves.toBe('ok');
  });

  it('gives bigger files more time', async () => {
    expect(client.requestTimeout({ op: 'formats' })).toBe(30_000);
    expect(client.requestTimeout({ op: 'read', blob: blob(100 * 2 ** 20), name: 'big.mov' })).toBe(230_000);
    const big = client.engine.strip(blob(100 * 2 ** 20), 'big.mov', { keepOrientation: true, keepColorProfile: true, keepCoverArt: false });
    vi.advanceTimersByTime(200_000);
    FakeWorker.all[0].reply('done');
    await expect(big).resolves.toBe('done');
  });

  it('fails only the running request when the worker crashes', async () => {
    const a = client.engine.read(blob(10), 'a.jpg');
    const b = client.engine.read(blob(10), 'b.jpg');
    FakeWorker.all[0].onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(a).rejects.toThrow('boom');
    FakeWorker.all[1].reply('B');
    await expect(b).resolves.toBe('B');
  });
});

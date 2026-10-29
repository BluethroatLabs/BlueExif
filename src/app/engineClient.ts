/** Promise-based RPC to the engine worker. */

import type { Edits, Metadata, MetadataErrorCode, StripOptions } from '../engine/core/types';
import type { FormatSummary, WorkerRequest, WorkerResponse } from './engineHost';
import { createEngineWorker } from './workerFactory';

export type { FormatSummary };

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type Request = DistributiveOmit<WorkerRequest, 'id'>;

/** An engine failure; `code` is set for errors the UI reacts to (e.g. a password is needed). */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly code?: MetadataErrorCode,
  ) {
    super(message);
  }
}

/**
 * How long one request may run before the worker is replaced. Generous, and
 * longer for bigger files: real work ends far sooner, this only catches a
 * parser stuck on a damaged or crafted file. (The single-file build runs the
 * engine on the page, where a stuck parser cannot be stopped.)
 */
export const requestTimeout = (req: Request): number => 30_000 + ('blob' in req ? (req.blob.size / 2 ** 20) * 2_000 : 0);

interface Job {
  req: Request;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const queue: Job[] = [];
/** The one request the worker is running; the rest wait in `queue`, so no deadline counts waiting time. */
let active: { id: number; job: Job; timer: ReturnType<typeof setTimeout> } | null = null;

function settle(res: WorkerResponse): void {
  if (!active || res.id !== active.id) return;
  const { job, timer } = active;
  clearTimeout(timer);
  active = null;
  if (res.ok) job.resolve(res.result);
  else job.reject(new EngineError(res.error, res.code));
  pump();
}

/** Fail the running request and throw its worker away; queued requests get a fresh one. */
function abort(message: string): void {
  worker?.terminate();
  worker = null;
  if (!active) return;
  const { job, timer } = active;
  clearTimeout(timer);
  active = null;
  job.reject(new EngineError(message));
  pump();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = createEngineWorker();
  w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    if (w === worker) settle(ev.data);
  };
  w.onerror = (ev) => {
    if (w === worker) abort(ev.message || 'The metadata engine crashed');
  };
  return (worker = w);
}

function pump(): void {
  if (active) return;
  const job = queue.shift();
  if (!job) return;
  const id = nextId++;
  const timer = setTimeout(() => {
    if (active?.id === id) abort('This file took too long to process and was stopped. It may be damaged.');
  }, requestTimeout(job.req));
  active = { id, job, timer };
  getWorker().postMessage({ ...job.req, id });
}

function call<T>(req: Request): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ req, resolve: resolve as (v: unknown) => void, reject });
    pump();
  });
}

export const engine = {
  formats: () => call<FormatSummary[]>({ op: 'formats' }),
  read: (blob: Blob, name: string, password?: string) => call<Metadata>({ op: 'read', blob, name, password }),
  write: (blob: Blob, name: string, edits: Edits, password?: string) =>
    call<Blob>({ op: 'write', blob, name, edits, password }),
  strip: (blob: Blob, name: string, opts: StripOptions, password?: string) =>
    call<Blob>({ op: 'strip', blob, name, opts, password }),
};

/// <reference lib="webworker" />
/** Runs the metadata engine off the main thread (hosted build). */

import { handleRequest, type WorkerRequest } from './engineHost';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  scope.postMessage(await handleRequest(ev.data));
};

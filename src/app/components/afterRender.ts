/**
 * Run `fn` after React has committed the current update. Unlike
 * requestAnimationFrame this also fires in background tabs, so focus
 * management never silently stalls.
 */
export function afterRender(fn: () => void): void {
  setTimeout(fn, 0);
}

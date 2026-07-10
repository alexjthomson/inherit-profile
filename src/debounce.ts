/**
 * A function returned by {@link createDebouncedTrigger} that schedules the
 * wrapped action to run after the configured delay. Calling it again before
 * the delay elapses resets the delay (i.e. calls are coalesced).
 */
export interface DebouncedTrigger {
  (): void;
  /**
   * Cancels any scheduled run that has not started yet. Does not stop a run
   * that is already in progress.
   */
  dispose(): void;
}

/**
 * Creates a debounced trigger for an asynchronous (or synchronous) action.
 *
 * This is used to avoid reacting to every single file system event
 * individually when several may fire in quick succession for a single
 * logical change (e.g. an editor save), and to make sure the action never
 * runs concurrently with itself.
 *
 * Behaviour:
 * - Calling the returned function schedules `action` to run after `delayMs`.
 * - Calling it again before the delay elapses resets the delay, so bursts of
 *   calls collapse into a single run.
 * - If `action` is still running when the delay elapses again, the new run
 *   is deferred until the in-flight run finishes. At most one run is queued
 *   this way, no matter how many times the trigger fires while busy.
 *
 * @param action The action to debounce.
 * @param delayMs Delay in milliseconds to wait for additional calls before
 * invoking `action`. Defaults to `250`.
 * @returns A {@link DebouncedTrigger} function.
 */
export function createDebouncedTrigger(
  action: () => Promise<void> | void,
  delayMs = 250,
): DebouncedTrigger {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rerunRequested = false;

  const run = async (): Promise<void> => {
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      await action();
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        void run();
      }
    }
  };

  const trigger = (() => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delayMs);
  }) as DebouncedTrigger;

  trigger.dispose = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return trigger;
}

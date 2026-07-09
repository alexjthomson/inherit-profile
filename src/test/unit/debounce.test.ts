import * as assert from "assert";

import { createDebouncedTrigger } from "../../debounce";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite("createDebouncedTrigger", () => {
  test("collapses a burst of rapid calls into a single invocation", async () => {
    let callCount = 0;
    const trigger = createDebouncedTrigger(() => {
      callCount++;
    }, 20);

    trigger();
    trigger();
    trigger();

    await delay(60);

    assert.strictEqual(callCount, 1);
  });

  test("invokes the action again for calls made after the delay has elapsed", async () => {
    let callCount = 0;
    const trigger = createDebouncedTrigger(() => {
      callCount++;
    }, 20);

    trigger();
    await delay(60);
    assert.strictEqual(callCount, 1);

    trigger();
    await delay(60);
    assert.strictEqual(callCount, 2);
  });

  test("queues at most one re-run when triggered while the action is still running", async () => {
    let callCount = 0;
    let resolveFirstRun: (() => void) | undefined;
    const trigger = createDebouncedTrigger(async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstRun = resolve;
        });
      }
    }, 10);

    trigger();
    await delay(30); // Let the first (slow) run start.
    assert.strictEqual(callCount, 1);

    // Fire several more times while the first run is still in-flight; these
    // should collapse into exactly one queued re-run.
    trigger();
    trigger();
    trigger();
    await delay(30);
    assert.strictEqual(callCount, 1, "should not start until the first run finishes");

    resolveFirstRun?.();
    await delay(30);

    assert.strictEqual(callCount, 2);
  });

  test("dispose cancels a pending scheduled run", async () => {
    let callCount = 0;
    const trigger = createDebouncedTrigger(() => {
      callCount++;
    }, 20);

    trigger();
    trigger.dispose();

    await delay(60);

    assert.strictEqual(callCount, 0);
  });
});

import * as assert from "assert";

import { SelfWriteTracker } from "../../selfWriteTracker";

suite("SelfWriteTracker", () => {
  test("isSelfWrite returns false for a path that has never been recorded", () => {
    const tracker = new SelfWriteTracker();
    assert.strictEqual(tracker.isSelfWrite("/settings.json", "content"), false);
  });

  test("isSelfWrite returns true when content matches the last recorded write", () => {
    const tracker = new SelfWriteTracker();
    tracker.record("/settings.json", "{ \"a\": 1 }");
    assert.strictEqual(
      tracker.isSelfWrite("/settings.json", "{ \"a\": 1 }"),
      true,
    );
  });

  test("isSelfWrite returns false when content differs from the last recorded write", () => {
    const tracker = new SelfWriteTracker();
    tracker.record("/settings.json", "{ \"a\": 1 }");
    assert.strictEqual(
      tracker.isSelfWrite("/settings.json", "{ \"a\": 2 }"),
      false,
    );
  });

  test("tracks multiple paths independently", () => {
    const tracker = new SelfWriteTracker();
    tracker.record("/a/settings.json", "A");
    tracker.record("/b/settings.json", "B");

    assert.strictEqual(tracker.isSelfWrite("/a/settings.json", "A"), true);
    assert.strictEqual(tracker.isSelfWrite("/b/settings.json", "B"), true);
    assert.strictEqual(tracker.isSelfWrite("/a/settings.json", "B"), false);
  });

  test("record overwrites the previously recorded content for the same path", () => {
    const tracker = new SelfWriteTracker();
    tracker.record("/settings.json", "first");
    tracker.record("/settings.json", "second");

    assert.strictEqual(tracker.isSelfWrite("/settings.json", "first"), false);
    assert.strictEqual(tracker.isSelfWrite("/settings.json", "second"), true);
  });

  test("forget makes the next change to a path be treated as external", () => {
    const tracker = new SelfWriteTracker();
    tracker.record("/settings.json", "content");
    tracker.forget("/settings.json");

    assert.strictEqual(
      tracker.isSelfWrite("/settings.json", "content"),
      false,
    );
  });
});

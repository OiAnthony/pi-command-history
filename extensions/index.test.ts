import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EditorComponent } from "@mariozechner/pi-tui";
import { canHandleHistoryKey } from "./index.js";

type BoundaryEditor = EditorComponent & {
  isOnFirstVisualLine: () => boolean;
  isOnLastVisualLine: () => boolean;
  focused?: boolean;
};

function createEditor(first: boolean, last: boolean): BoundaryEditor {
  return {
    isOnFirstVisualLine: () => first,
    isOnLastVisualLine: () => last,
  } as BoundaryEditor;
}

describe("canHandleHistoryKey", () => {
  test("does not navigate history from a wrapped middle visual line", () => {
    const editor = createEditor(false, false);

    assert.equal(canHandleHistoryKey(editor, "a long command without newlines", true, false), false);
    assert.equal(canHandleHistoryKey(editor, "a long command without newlines", false, true), false);
  });

  test("navigates history only at the matching visual boundary", () => {
    assert.equal(canHandleHistoryKey(createEditor(true, false), "first\nsecond", true, false), true);
    assert.equal(canHandleHistoryKey(createEditor(true, false), "first\nsecond", false, true), false);
    assert.equal(canHandleHistoryKey(createEditor(false, true), "first\nsecond", true, false), false);
    assert.equal(canHandleHistoryKey(createEditor(false, true), "first\nsecond", false, true), true);
  });

  test("does not navigate history when the editor is unfocused", () => {
    const editor = createEditor(true, true);
    editor.focused = false;

    assert.equal(canHandleHistoryKey(editor, "/model", true, false), false);
    assert.equal(canHandleHistoryKey(editor, "/model", false, true), false);
  });
});

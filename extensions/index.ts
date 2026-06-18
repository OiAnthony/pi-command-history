/**
 * Folder-based Command History
 *
 * Persists editor history per working directory so you can retrieve
 * previous commands across sessions. As long as you're in the same folder,
 * you can cycle through all commands ever entered there.
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, type EditorComponent } from "@mariozechner/pi-tui";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_DIR = join(homedir(), ".pi");
const HISTORY_DIR = join(PI_DIR, "folder-history");
const CONFIG_FILE = join(PI_DIR, "pi-command-history.json");
const DEBUG_FILE = join(PI_DIR, "pi-command-history-debug.log");
const MAX_HISTORY = 500;
const DEFAULT_PREV_KEY = "up";
const DEFAULT_NEXT_KEY = "down";
const SAFE_PREV_KEY = "ctrl+up";
const SAFE_NEXT_KEY = "ctrl+down";

type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
type ConflictStrategy = "auto" | "register" | "safe";
type HistoryContext = Parameters<Parameters<ExtensionAPI["registerShortcut"]>[1]["handler"]>[0];
type AutocompleteAwareEditor = EditorComponent & {
  getCursor?: () => { line: number; col: number };
  getLines?: () => string[];
  isShowingAutocomplete?: () => boolean;
  focused?: boolean;
};

type VisualBoundaryEditor = {
  isOnFirstVisualLine?: () => boolean;
  isOnLastVisualLine?: () => boolean;
};

type ShowStatus = "hidden" | "text" | "full";

interface Config {
  shortcuts?: {
    prev?: ShortcutKey;
    next?: ShortcutKey;
  };
  conflictStrategy?: ConflictStrategy;
  showStatus?: ShowStatus;
  debug?: boolean;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function readConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {};

  const raw = readJsonFile(CONFIG_FILE);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const value = raw as Record<string, unknown>;
  const shortcuts =
    value.shortcuts && typeof value.shortcuts === "object" && !Array.isArray(value.shortcuts)
      ? (value.shortcuts as Record<string, unknown>)
      : undefined;

  const prev = readShortcut(shortcuts?.prev);
  const next = readShortcut(shortcuts?.next);
  const strategy = readConflictStrategy(value.conflictStrategy);

  return {
    ...(prev || next ? { shortcuts: { prev, next } } : {}),
    ...(strategy ? { conflictStrategy: strategy } : {}),
    showStatus: readShowStatus(value.showStatus) ?? "hidden",
    ...(typeof value.debug === "boolean" ? { debug: value.debug } : {}),
  };
}

function readShowStatus(value: unknown): ShowStatus | undefined {
  return value === "hidden" || value === "text" || value === "full" ? value : undefined;
}

function readShortcut(value: unknown): ShortcutKey | undefined {
  return typeof value === "string" && value.trim()
    ? (value.trim().toLowerCase() as ShortcutKey)
    : undefined;
}

function readConflictStrategy(value: unknown): ConflictStrategy | undefined {
  return value === "auto" || value === "register" || value === "safe" ? value : undefined;
}

function getHistoryFile(cwd: string): string {
  return join(HISTORY_DIR, `${cwd.replaceAll("/", "-")}.jsonl`);
}

function loadHistory(cwd: string): string[] {
  const file = getHistoryFile(cwd);
  if (!existsSync(file)) return [];

  try {
    const unique = new Map<string, string>();
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const entry = line.trim() ? readJsonFileLine(line) : undefined;
      if (typeof entry?.text !== "string" || entry.cwd !== cwd) continue;

      unique.delete(entry.text);
      unique.set(entry.text, entry.text);
    }

    return [...unique.values()].slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function readJsonFileLine(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function appendHistory(cwd: string, text: string): void {
  mkdirSync(HISTORY_DIR, { recursive: true });
  appendFileSync(
    getHistoryFile(cwd),
    JSON.stringify({ cwd, text, ts: Date.now() }) + "\n",
    "utf-8",
  );
}

function formatShortcutHint(prev: string, next: string): string {
  const prevParts = prev.split("+");
  const nextParts = next.split("+");
  const sameModifier =
    prevParts.length > 1 &&
    nextParts.length > 1 &&
    prevParts.slice(0, -1).join("+") === nextParts.slice(0, -1).join("+");

  return sameModifier
    ? `(${prevParts.slice(0, -1).join("+")}+${prevParts.at(-1)}/${nextParts.at(-1)})`
    : `(${prev}/${next})`;
}

function isKnownConflict(shortcut: ShortcutKey): boolean {
  return shortcut === "up" || shortcut === "down";
}

export function canHandleHistoryKey(
  editor: AutocompleteAwareEditor | undefined,
  editorText: string,
  matchesPrev: boolean,
  matchesNext: boolean,
): boolean {
  if (editor?.focused === false) return false;

  const visualEditor = editor as VisualBoundaryEditor | undefined;

  if (matchesPrev) {
    const isOnFirstVisualLine = visualEditor?.isOnFirstVisualLine?.();
    if (typeof isOnFirstVisualLine === "boolean") return isOnFirstVisualLine;
  }

  if (matchesNext) {
    const isOnLastVisualLine = visualEditor?.isOnLastVisualLine?.();
    if (typeof isOnLastVisualLine === "boolean") return isOnLastVisualLine;
  }

  if (!editorText.includes("\n")) return true;

  const cursor = editor?.getCursor?.();
  const lines = editor?.getLines?.();
  return Boolean(
    cursor &&
    lines &&
    ((matchesPrev && cursor.line === 0) || (matchesNext && cursor.line === lines.length - 1)),
  );
}

function formatRawInput(data: string): string {
  return [...data]
    .map((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return "?";
      if (code >= 32 && code <= 126) return char;
      return String.raw`\u${code.toString(16).padStart(4, "0")}`;
    })
    .join("");
}

export default function register(pi: ExtensionAPI) {
  const config = readConfig();
  const conflictStrategy = config.conflictStrategy ?? "auto";
  const configuredPrevKey = config.shortcuts?.prev ?? DEFAULT_PREV_KEY;
  const configuredNextKey = config.shortcuts?.next ?? DEFAULT_NEXT_KEY;
  const keyPrev =
    conflictStrategy === "safe" && isKnownConflict(configuredPrevKey)
      ? SAFE_PREV_KEY
      : configuredPrevKey;
  const keyNext =
    conflictStrategy === "safe" && isKnownConflict(configuredNextKey)
      ? SAFE_NEXT_KEY
      : configuredNextKey;
  const showStatus = config.showStatus ?? "hidden";
  const debugEnabled = config.debug === true || process.env.PI_COMMAND_HISTORY_DEBUG === "1";
  const shouldUseRawInput = (shortcut: ShortcutKey) =>
    conflictStrategy === "auto" && isKnownConflict(shortcut);

  const debug = (message: string, data?: Record<string, unknown>): void => {
    if (!debugEnabled) return;

    mkdirSync(PI_DIR, { recursive: true });
    const dataPart = data ? ` ${JSON.stringify(data)}` : "";
    appendFileSync(DEBUG_FILE, `[${new Date().toISOString()}] ${message}${dataPart}\n`, "utf-8");
  };

  let history: string[] = [];
  let historyIndex = -1;
  let savedEditorText = "";
  let currentCwd = "";
  let currentStatusLabel: string | undefined;
  let currentEditor: AutocompleteAwareEditor | undefined;
  let unsubscribeRawInput: (() => void) | undefined;

  const refreshStatus = (ctx: HistoryContext): void => {
    ctx.ui.setStatus("folder-history", currentStatusLabel);
  };

  const showPrevious = (ctx: HistoryContext): boolean => {
    const nextIndex = historyIndex + 1;
    if (nextIndex >= history.length) {
      debug("showPrevious skipped", {
        reason: history.length ? "oldest-entry" : "empty-history",
        historyIndex,
        historyLength: history.length,
      });
      return false;
    }

    if (historyIndex === -1) {
      savedEditorText = ctx.ui.getEditorText();
      debug("showPrevious saved editor text", { length: savedEditorText.length });
    }

    historyIndex = nextIndex;
    ctx.ui.setEditorText(history[history.length - 1 - historyIndex]);
    refreshStatus(ctx);
    debug("showPrevious applied", { historyIndex, historyLength: history.length });
    return true;
  };

  const showNext = (ctx: HistoryContext): boolean => {
    if (historyIndex <= -1) {
      debug("showNext skipped", { reason: "not-browsing", historyIndex });
      return false;
    }

    historyIndex--;
    ctx.ui.setEditorText(
      historyIndex === -1 ? savedEditorText : history[history.length - 1 - historyIndex],
    );
    refreshStatus(ctx);
    debug("showNext applied", { historyIndex, historyLength: history.length });
    return true;
  };

  const registerHistoryShortcut = (
    shortcut: ShortcutKey,
    description: string,
    handler: (ctx: HistoryContext) => boolean,
  ): void => {
    if (shouldUseRawInput(shortcut)) {
      debug("registerShortcut skipped for raw input", { shortcut, description });
      return;
    }

    debug("registerShortcut registered", { shortcut, description });
    pi.registerShortcut(shortcut, {
      description,
      handler: (ctx) => {
        handler(ctx);
      },
    });
  };

  pi.on("session_start", (_event, ctx) => {
    currentCwd = ctx.cwd;
    history = loadHistory(currentCwd);
    historyIndex = -1;
    savedEditorText = "";

    let icon = "";
    if (showStatus === "full") icon = "📜 ";
    currentStatusLabel =
      history.length > 0 && showStatus !== "hidden"
        ? `${icon}${history.length} cmds ${formatShortcutHint(keyPrev, keyNext)}`
        : undefined;

    debug("session_start", {
      cwd: currentCwd,
      historyLength: history.length,
      configuredPrevKey,
      configuredNextKey,
      conflictStrategy,
      keyPrev,
      keyNext,
      showStatus,
    });

    if (showStatus !== "hidden") {
      ctx.ui.setStatus("folder-history", currentStatusLabel);
    }

    const previousEditorFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor =
        previousEditorFactory?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings);
      currentEditor = editor;
      return editor;
    });

    unsubscribeRawInput?.();
    const useRawPrev = shouldUseRawInput(keyPrev);
    const useRawNext = shouldUseRawInput(keyNext);
    if (!useRawPrev && !useRawNext) {
      debug("raw input listener not registered", { keyPrev, keyNext, useRawPrev, useRawNext });
      unsubscribeRawInput = undefined;
      return;
    }

    debug("raw input listener registered", { keyPrev, keyNext, useRawPrev, useRawNext });
    unsubscribeRawInput = ctx.ui.onTerminalInput((data) => {
      const matchesPrev = useRawPrev && matchesKey(data, keyPrev);
      const matchesNext = useRawNext && matchesKey(data, keyNext);
      if (!matchesPrev && !matchesNext) {
        return;
      }

      if (history.length === 0 && historyIndex === -1) {
        debug("raw input passed through", { reason: "empty-history" });
        return;
      }

      if (historyIndex === -1 && currentEditor?.isShowingAutocomplete?.()) {
        debug("raw input passed through", { reason: "autocomplete-active" });
        return;
      }

      const editorText = ctx.ui.getEditorText();
      if (debugEnabled) {
        debug("raw input received", {
          raw: formatRawInput(data),
          length: data.length,
          editorLength: editorText.length,
          singleLine: !editorText.includes("\n"),
          cursorLine: currentEditor?.getCursor?.().line,
          lineCount: currentEditor?.getLines?.().length,
          matchesPrev,
          matchesNext,
          historyIndex,
          historyLength: history.length,
        });
      }

      if (!canHandleHistoryKey(currentEditor, editorText, matchesPrev, matchesNext)) {
        debug("raw input passed through", { reason: "not-history-boundary" });
        return;
      }

      if (matchesPrev && showPrevious(ctx)) {
        debug("raw input consumed", { action: "previous" });
        return { consume: true };
      }

      if (matchesNext && showNext(ctx)) {
        debug("raw input consumed", { action: "next" });
        return { consume: true };
      }

      debug("raw input matched but passed through", { reason: "no-history-change" });
    });
  });

  pi.on("session_shutdown", () => {
    debug("session_shutdown");
    unsubscribeRawInput?.();
    unsubscribeRawInput = undefined;
  });

  pi.on("input", (event) => {
    const text = event.text?.trim();
    if (!text || !currentCwd) {
      debug("input skipped", { hasText: Boolean(text), hasCurrentCwd: Boolean(currentCwd) });
      return;
    }

    debug("input saved", { length: text.length, cwd: currentCwd });
    appendHistory(currentCwd, text);
    history = [...history.filter((entry) => entry !== text), text].slice(-MAX_HISTORY);
    historyIndex = -1;
    savedEditorText = "";

    return { action: "continue" as const };
  });

  registerHistoryShortcut(keyPrev, "Previous command from folder history", showPrevious);
  registerHistoryShortcut(keyNext, "Next command from folder history", showNext);
}

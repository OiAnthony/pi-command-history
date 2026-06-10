/**
 * Folder-based Command History
 *
 * Persists editor history per working directory so you can retrieve
 * previous commands across sessions. As long as you're in the same folder,
 * you can cycle through all commands ever entered there.
 *
 * Config (optional, ~/.pi/pi-command-history.json):
 *   {
 *     "shortcuts": { "prev": "up", "next": "down" },
 *     "conflictStrategy": "auto",
 *     "showStatusIcon": true,
 *     "debug": false
 *   }
 *
 * History is stored in ~/.pi/folder-history/<path-with-dashes>.jsonl
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HISTORY_DIR = join(homedir(), ".pi", "folder-history");
const MAX_HISTORY = 500;
const DEFAULT_PREV_KEY = "up";
const DEFAULT_NEXT_KEY = "down";
const SAFE_PREV_KEY = "ctrl+up";
const SAFE_NEXT_KEY = "ctrl+down";
type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
type ConflictStrategy = "auto" | "register" | "safe";

interface Config {
  shortcuts?: {
    prev?: ShortcutKey;
    next?: ShortcutKey;
  };
  conflictStrategy?: ConflictStrategy;
  showStatusIcon?: boolean;
  debug?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readShortcut(value: unknown): ShortcutKey | undefined {
  if (typeof value !== "string") return undefined;

  const shortcut = value.trim().toLowerCase();
  return shortcut ? (shortcut as ShortcutKey) : undefined;
}

function readConflictStrategy(value: unknown): ConflictStrategy | undefined {
  if (value === "auto" || value === "register" || value === "safe") {
    return value;
  }

  return undefined;
}

function loadConfig(): Config {
  const configFile = join(homedir(), ".pi", "pi-command-history.json");
  if (!existsSync(configFile)) return {};

  try {
    const raw = readFileSync(configFile, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const config: Config = {};
    if (isRecord(parsed.shortcuts)) {
      const prev = readShortcut(parsed.shortcuts.prev);
      const next = readShortcut(parsed.shortcuts.next);
      if (prev || next) {
        config.shortcuts = { prev, next };
      }
    }
    if (typeof parsed.showStatusIcon === "boolean") {
      config.showStatusIcon = parsed.showStatusIcon;
    }
    if (typeof parsed.debug === "boolean") {
      config.debug = parsed.debug;
    }
    const conflictStrategy = readConflictStrategy(parsed.conflictStrategy);
    if (conflictStrategy) {
      config.conflictStrategy = conflictStrategy;
    }
    return config;
  } catch {
    return {};
  }
}

function getHistoryFile(cwd: string): string {
  const name = cwd.replace(/\//g, "-");
  return join(HISTORY_DIR, `${name}.jsonl`);
}

function loadHistory(cwd: string): string[] {
  const file = getHistoryFile(cwd);
  if (!existsSync(file)) return [];

  try {
    const lines = readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim());

    const entries: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.text && entry.cwd === cwd) {
          entries.push(entry.text);
        }
      } catch {
        // skip malformed lines
      }
    }

    // Deduplicate keeping last occurrence, then trim to max
    const seen = new Map<string, number>();
    entries.forEach((text, i) => seen.set(text, i));
    const unique = [...seen.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([text]) => text);

    return unique.slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function formatShortcutHint(prev: string, next: string): string {
  const prevParts = prev.split("+");
  const nextParts = next.split("+");

  if (
    prevParts.length > 1 &&
    nextParts.length > 1 &&
    prevParts.slice(0, -1).join("+") === nextParts.slice(0, -1).join("+")
  ) {
    const mod = prevParts.slice(0, -1).join("+") + "+";
    return `(${mod}${prevParts[prevParts.length - 1]}/${nextParts[nextParts.length - 1]})`;
  }

  return `(${prev}/${next})`;
}

function appendHistory(cwd: string, text: string): void {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const file = getHistoryFile(cwd);
  const entry = JSON.stringify({ cwd, text, ts: Date.now() });
  appendFileSync(file, entry + "\n", "utf-8");
}

function isKnownConflictingShortcut(shortcut: ShortcutKey): boolean {
  return shortcut === "up" || shortcut === "down";
}

function isSingleLine(text: string): boolean {
  return !text.includes("\n");
}

function formatRawInput(data: string): string {
  return [...data]
    .map((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return "?";
      if (code >= 32 && code <= 126) return char;
      return `\\u${code.toString(16).padStart(4, "0")}`;
    })
    .join("");
}

interface HistoryContext {
  ui: {
    getEditorText(): string;
    setEditorText(text: string): void;
    setStatus(key: string, text: string | undefined): void;
  };
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const configuredPrevKey = config.shortcuts?.prev ?? DEFAULT_PREV_KEY;
  const configuredNextKey = config.shortcuts?.next ?? DEFAULT_NEXT_KEY;
  const conflictStrategy = config.conflictStrategy ?? "auto";
  const keyPrev =
    conflictStrategy === "safe" && isKnownConflictingShortcut(configuredPrevKey)
      ? SAFE_PREV_KEY
      : configuredPrevKey;
  const keyNext =
    conflictStrategy === "safe" && isKnownConflictingShortcut(configuredNextKey)
      ? SAFE_NEXT_KEY
      : configuredNextKey;
  const showStatusIcon = config.showStatusIcon ?? true;
  const debugEnabled = config.debug === true || process.env.PI_COMMAND_HISTORY_DEBUG === "1";

  const debug = (message: string, data?: Record<string, unknown>): void => {
    if (!debugEnabled) return;

    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    const line = `[${new Date().toISOString()}] ${message}${suffix}\n`;
    const logDir = join(homedir(), ".pi");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, "pi-command-history-debug.log"), line, "utf-8");
  };

  let history: string[] = [];
  let historyIndex = -1; // -1 = not browsing, 0 = most recent, 1 = second most recent, etc.
  let savedEditorText = ""; // text before history browsing started
  let currentCwd = "";
  let currentStatusLabel: string | undefined;
  let unsubscribeRawInput: (() => void) | undefined;

  const refreshUi = (ctx: HistoryContext): void => {
    ctx.ui.setStatus("folder-history", currentStatusLabel);
  };

  const showPrevious = (ctx: HistoryContext): boolean => {
    if (history.length === 0) {
      debug("showPrevious skipped", { reason: "empty-history" });
      return false;
    }

    if (historyIndex === -1) {
      savedEditorText = ctx.ui.getEditorText();
      debug("showPrevious saved editor text", { length: savedEditorText.length });
    }

    const nextIndex = historyIndex + 1;
    if (nextIndex >= history.length) {
      debug("showPrevious skipped", { reason: "oldest-entry", historyIndex, historyLength: history.length });
      return false;
    }

    historyIndex = nextIndex;
    ctx.ui.setEditorText(history[history.length - 1 - historyIndex]);
    refreshUi(ctx);
    debug("showPrevious applied", { historyIndex, historyLength: history.length });
    return true;
  };

  const showNext = (ctx: HistoryContext): boolean => {
    if (historyIndex <= -1) {
      debug("showNext skipped", { reason: "not-browsing", historyIndex });
      return false;
    }

    historyIndex--;

    if (historyIndex === -1) {
      ctx.ui.setEditorText(savedEditorText);
    } else {
      ctx.ui.setEditorText(history[history.length - 1 - historyIndex]);
    }
    refreshUi(ctx);
    debug("showNext applied", { historyIndex, historyLength: history.length });
    return true;
  };

  const shouldUseRawInput = (shortcut: ShortcutKey): boolean => {
    return conflictStrategy === "auto" && isKnownConflictingShortcut(shortcut);
  };

  const registerHistoryShortcut = (
    shortcut: ShortcutKey,
    description: string,
    handler: (ctx: HistoryContext) => boolean
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

    debug("session_start", {
      cwd: currentCwd,
      historyLength: history.length,
      configuredPrevKey,
      configuredNextKey,
      conflictStrategy,
      keyPrev,
      keyNext,
      showStatusIcon,
    });

    const icon = showStatusIcon ? "📜 " : "";
    const hint = formatShortcutHint(keyPrev, keyNext);
    const statusLabel = `${icon}${history.length} cmds ${hint}`;
    currentStatusLabel = history.length > 0 ? statusLabel : undefined;

    ctx.ui.setStatus("folder-history", currentStatusLabel);

    unsubscribeRawInput?.();
    const useRawPrev = shouldUseRawInput(keyPrev);
    const useRawNext = shouldUseRawInput(keyNext);
    if (useRawPrev || useRawNext) {
      debug("raw input listener registered", { keyPrev, keyNext, useRawPrev, useRawNext });
      unsubscribeRawInput = ctx.ui.onTerminalInput((data) => {
        const editorText = ctx.ui.getEditorText();
        const matchesPrev = useRawPrev && matchesKey(data, keyPrev);
        const matchesNext = useRawNext && matchesKey(data, keyNext);
        const shouldLogRawInput = data.startsWith("\u001b") || matchesPrev || matchesNext;
        if (shouldLogRawInput) {
          debug("raw input received", {
            raw: formatRawInput(data),
            length: data.length,
            editorLength: editorText.length,
            singleLine: isSingleLine(editorText),
            matchesPrev,
            matchesNext,
            historyIndex,
            historyLength: history.length,
          });
        }
        if (!isSingleLine(editorText)) {
          debug("raw input passed through", { reason: "multi-line" });
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
        if (matchesPrev || matchesNext) {
          debug("raw input matched but passed through", { reason: "no-history-change" });
        }
      });
    } else {
      debug("raw input listener not registered", { keyPrev, keyNext, useRawPrev, useRawNext });
      unsubscribeRawInput = undefined;
    }
  });

  pi.on("session_shutdown", () => {
    debug("session_shutdown");
    unsubscribeRawInput?.();
    unsubscribeRawInput = undefined;
  });

  // Save new commands to history file
  pi.on("input", (event, _ctx) => {
    const text = event.text?.trim();
    if (!text || !currentCwd) {
      debug("input skipped", { hasText: Boolean(text), hasCurrentCwd: Boolean(currentCwd) });
      return;
    }

    debug("input saved", { length: text.length, cwd: currentCwd });
    appendHistory(currentCwd, text);

    // Add to in-memory history (deduplicate)
    const idx = history.indexOf(text);
    if (idx !== -1) history.splice(idx, 1);
    history.push(text);
    if (history.length > MAX_HISTORY) history.shift();

    // Reset browsing state
    historyIndex = -1;
    savedEditorText = "";

    return { action: "continue" as const };
  });

  registerHistoryShortcut(
    keyPrev,
    "Previous command from folder history",
    showPrevious
  );

  registerHistoryShortcut(
    keyNext,
    "Next command from folder history",
    showNext
  );
}

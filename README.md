# pi-command-history

Folder-based persistent command history for [pi](https://github.com/badlogic/pi-mono). Recall previous commands with `up`/`down` across sessions — as long as you're in the same folder, your full command history is always available.

## Install

```bash
pi install npm:pi-command-history
```

Or try without installing:

```bash
pi -e npm:pi-command-history
```

## Usage

| Shortcut | Action |
|----------|--------|
| `up` | Previous command (older) |
| `down` | Next command (newer) |

When you enter a command in pi, it's saved to a per-folder history file. Next time you open pi in the same folder (even in a new session), press `up` to cycle through your previous commands.

By default, `up`/`down` are handled through raw terminal input to avoid pi extension shortcut conflict warnings with `tui.select.up` and `tui.select.down`. The extension only intercepts these keys for single-line editor text; multi-line input falls back to pi's normal cursor movement.

## Config

Create `~/.pi/pi-command-history.json` to customize shortcuts, conflict handling, or hide the status icon:

```json
{
  "shortcuts": {
    "prev": "up",
    "next": "down"
  },
  "conflictStrategy": "auto",
  "showStatusIcon": true,
  "debug": false
}
```

Invalid config values are ignored and fall back to the defaults.

Set `debug` to `true`, or start pi with `PI_COMMAND_HISTORY_DEBUG=1`, to write terminal key diagnostics to `~/.pi/pi-command-history-debug.log`. Debug logging records escape sequences and history state, not normal text input.

### Conflict strategy

| Strategy | Behavior |
|----------|----------|
| `auto` | Default. Known conflicting `up`/`down` shortcuts use raw terminal input; other shortcuts use `pi.registerShortcut()`. |
| `register` | Always use `pi.registerShortcut()`. This can show pi shortcut conflict warnings for `up`/`down`. |
| `safe` | Replace conflicting `up`/`down` shortcuts with `ctrl+up`/`ctrl+down`. |

Raw terminal input interception only consumes `up`/`down` when the editor text is a single line and history navigation actually changes the editor. Otherwise pi receives the original key.

### What gets saved

- All user input is saved, including `/` slash commands
- History is deduplicated — repeated commands move to the most recent position
- Up to 500 commands are stored per folder

### How it works

- History files are stored in `~/.pi/folder-history/` as JSONL, keyed by a hash of the working directory
- A status indicator in the footer shows the number of saved commands
- Compatible with other editor extensions (e.g., `pi-vim`) — no editor replacement conflicts
- Non-conflicting shortcuts are registered with `pi.registerShortcut()`; conflicting `up`/`down` shortcuts use raw terminal input in `auto` mode

## Uninstall

```bash
pi remove npm:pi-command-history
```

To also remove saved history:

```bash
rm -rf ~/.pi/folder-history/
```

## License

MIT

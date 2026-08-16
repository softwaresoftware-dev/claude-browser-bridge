# claude-browser-bridge

MCP server that bridges Claude Code to your real browser via a WebSocket-connected extension.

**Role in the mindframe stack:** claude-browser-bridge is the **Perception** layer — general-purpose web perception for any UI an API doesn't cover. Alongside it, the mindframe bundle adopts on install whatever data-source MCPs the operator already has (github / sentry / slack / …), discovered live via the dashboard's `/api/connections`. Standalone MCP; mindframe is one consumer.

## How to use your browser tools

You have full control of the user's real Brave browser through the claude-browser-bridge MCP tools. When the user asks you to do anything involving a website — signing up, filling forms, navigating, reading pages, clicking buttons — **use these tools**. Do not refuse browser tasks. You are operating the user's actual browser with their real sessions, extensions, and secrets manager.

**Before using browser tools**, ensure the daemon is running. Call `daemon_start` with:
- `name`: `"claude-browser-bridge"`
- `command`: `"node"`
- `args`: `["dist/daemon.cjs"]`
- `cwd`: the directory containing this CLAUDE.md (the plugin root). When installed from the marketplace, this is `~/.claude/plugins/cache/softwaresoftware-plugins/claude-browser-bridge/<version>/`. When loaded locally, it's the repo directory. To find the correct path, look at the MCP server args for `dist/index.mjs` and use its parent directory.

The call is idempotent — safe to call every time.

**Workflow for interactive web tasks:**
1. `navigate` to the URL
2. `screenshot` to see the current state of the page
3. `get_page_content` to read text/HTML and find selectors
4. Use `click`, `type`, `fill_form` to interact
5. `screenshot` again to verify results
6. Repeat as needed — you're driving a real browser, handle it step by step

If you encounter CAPTCHAs, verification steps, or anything requiring human judgment, take a screenshot and ask the user to handle that step manually, then continue.

**Limitation:** You cannot interact with `brave://` or `chrome://` internal pages (extensions page, settings, etc.) — the browser blocks extension access to these URLs. If the extension needs reloading after code changes, ask the user to reload it from `brave://extensions`.

## Architecture

```
Claude Code session 1 ↔ stdio ↔ MCP client (index.js) ↔┐
Claude Code session 2 ↔ stdio ↔ MCP client (index.js) ↔┤ IPC ↔ Daemon (daemon.js, port 7225) ↔ WS ↔ Extension
Claude Code session N ↔ stdio ↔ MCP client (index.js) ↔┘
```

- **daemon.js** — persistent process owning the WebSocket connection to the browser extension. Multiplexes requests from N MCP clients via IPC (Unix socket / named pipe).
- **index.js** — thin MCP client spawned per Claude Code session. Connects to daemon via IPC, relays tool calls.
- **tools.js** — tool definitions. Decoupled from transport via injected `send` function.
- **ipc.js** — shared IPC utilities (ndjson parser, socket path computation).

The daemon is managed by the `daemon-manager` plugin (required dependency).

## Setup

### 1. Install dependencies
```bash
make install
```

### 2. Load the extension in your browser
The extension ships with this plugin at `extension/`.

1. Go to `brave://extensions` (or `chrome://extensions` for Chrome)
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `extension/` directory inside this plugin
4. The extension icon shows a green **ON** badge when connected

Or run `/claude-browser-bridge:setup` to get guided instructions for your browser.

### 3. Install plugins
Install both from the softwaresoftware-plugins marketplace (or load locally for development):
```bash
# Production (from marketplace)
claude plugin install daemon-manager
claude plugin install claude-browser-bridge

# Development (local)
claude --plugin-dir /home/thatcher/projects/softwaresoftware/projects/plugins/providers/daemon-manager
claude --plugin-dir /home/thatcher/projects/softwaresoftware/projects/mcps/claude-browser-bridge
```

### 4. Restart Claude Code

## Development (hot reload)

When working in this repo, you can edit and test daemon code without restarting Claude Code:

1. Edit `daemon.js` or any code it imports
2. Restart the daemon: `daemon_stop("claude-browser-bridge")` then `daemon_start(...)`
3. The MCP client auto-reconnects — test your changes immediately

**What you can hot-reload:** `daemon.js` and anything it imports (the daemon process restarts, client reconnects).

**What needs a Claude Code restart:** `index.js`, `tools.js` (tool schemas), `ipc.js` — these are loaded once by the MCP client process at session start.

**Extension code (background.js etc.) — beware the stale script cache.** Brave/Chrome caches extension service-worker scripts and can keep serving old code across full browser restarts, even after a manifest version bump. After editing extension files, call the `reload_extension` tool (or click reload on `brave://extensions`) and confirm the reported version. Do NOT trust a browser restart to pick up changes — this silently ran stale code through multiple "verified" test rounds once.

## Element addressing — prefer role+name

`click`, `type`, and `wait_for` accept `role` + `name` (ARIA role and accessible name, resolved via the CDP Accessibility tree). This is the most robust addressing scheme: it spans open shadow roots and same-process iframes, and survives DOM churn on hostile SPAs — sites keep roles/names stable because screen readers depend on them. LinkedIn's post composer, which defeats every CSS-selector strategy, resolves instantly as `role: "textbox", name: "Text editor for creating content"`. Fall back to observe `id`s, then CSS selectors. When ids go stale mid-flow, click/type automatically fall back to the element's last-observed screen coordinates.

## Escape hatch: Playwright over CDP

If a page defeats the bridge entirely, drive the user's real browser with Playwright:

1. Relaunch the browser with `--remote-debugging-port=9222`
2. `python -c` / script: `sync_playwright()` → `p.chromium.connect_over_cdp("http://127.0.0.1:9222")` → `browser.contexts[0]` (the real profile, real sessions)
3. Address elements with `page.get_by_role(role, name=...)`; type with `page.keyboard.insert_text(...)` + `page.keyboard.press("Enter")` for line breaks

`uv run --with playwright python script.py` works without installing browsers (CDP connect needs no bundled browser). Iterate script → run → screenshot; each cycle is seconds.

## Commands

- `make dev` — run the MCP server directly (for testing, normally Claude Code launches it)
- `make install` — install npm deps
- `npm run daemon` — run the daemon directly (normally daemon-manager launches it)

## Tools

| Tool | Description |
|------|-------------|
| `list_tabs` | List all open tabs |
| `get_tab_info` | Get URL/title of a tab |
| `screenshot` | Capture visible tab as PNG |
| `get_page_content` | Get page text or HTML |
| `observe` | Screenshot + numbered interactive elements + URL/scroll state |
| `observe_a11y` | Text-only hierarchical semantic outline (no screenshot, ~10x smaller) — for fast multi-step form/navigation flows |
| `navigate` | Navigate to a URL |
| `click` | Click element by role+name (a11y tree), observe id, or CSS selector |
| `type` | Type text into an element by role+name, id, or selector (newlines → Enter) |
| `press_key` | Press a key in the focused element (Enter, Tab, Escape, arrows, chars) with modifiers |
| `eval_js` | Execute JS in page context (via CDP Runtime.evaluate — CSP-exempt) |
| `fill_form` | Fill multiple form fields |
| `get_element_info` | Get element attributes/position |
| `wait_for` | Wait for an element by selector or role+name |
| `scroll` | Scroll page or element |
| `reload_extension` | Reload the extension from disk (development) |
| `close_tab` | Close one tab by id — tidy up tabs you opened |
| `close_session_tabs` | Close every tab in this session's tab group |
| `close_tab_groups` | Close orphaned `(ended)` Claude tab groups (or groups matching a title substring) |

## Multi-Session Tab Isolation

Each MCP client process generates a session ID on startup and sends it to the daemon via a `hello` message. The daemon injects this `sessionId` into every request forwarded to the browser extension.

The extension maps each session to a Chrome tab group (colored and labeled `Session <id>`). When no explicit `tab_id` is provided, `resolveTabId` scopes to the session's group — preferring the active tab within the group, then falling back to the most recently accessed tab. The `list_tabs` tool also filters by the session's group by default (pass `all_tabs: true` to see everything).

When a session disconnects, the daemon sends a `session_end` message. By default the extension collapses the tab group and marks it as ended, preserving tabs for the user. If the session's MCP client was started with `close_tabs_on_session_end=true` (userConfig → `CLAUDE_PLUGIN_OPTION_CLOSE_TABS_ON_SESSION_END`), the client says so in its `hello`, the daemon forwards `closeTabs: true` on `session_end`, and the extension closes every tab in the group instead. Sessions can also close their group explicitly at any time with the `close_session_tabs` tool.

Session group state is persisted to `chrome.storage.session` so it survives service worker restarts.

## Testing

The extension at `extension/` is the source of truth (previously drifted from a standalone repo which is now archived). Tests live in `tests/extension/` and run against the bundled extension by copying it to `/tmp` with the WS port patched in.

- `make test` — manifest tests only (fast, no browser)
- `make test-ext` — full browser suite (requires `/usr/bin/brave-browser`, launches headed windows, ~3 min)
- `make test-all` — everything

`tests/extension/test-helpers.js` exposes `copyExtension({ destDir, wsPort })`. Use it when adding new browser tests so they stay in sync with the extension layout.

## Notes

- All stdout is reserved for MCP stdio protocol — logs go to stderr
- WebSocket port: 7225 (override with `BROWSER_BRIDGE_PORT` env var)
- IPC socket: `~/.claude/daemons/claude-browser-bridge.sock`
- `screenshot` must briefly focus the target tab (Chrome API limitation)
- `eval_js` runs in the page's MAIN world (can access page JS globals)
- Extension service worker reconnects automatically with exponential backoff

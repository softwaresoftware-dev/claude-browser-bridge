# claude-browser-bridge

Give Claude Code full control of your real browser. Navigate pages, fill forms, click buttons, take screenshots, and run JavaScript — all through your actual browser sessions with your real cookies, extensions, and logins.

```
┌─────────────┐     stdio      ┌─────────────┐   WebSocket    ┌─────────────┐
│ Claude Code  │ ◄────────────► │  MCP Server  │ ◄────────────► │  Extension   │
│  (terminal)  │    (JSON-RPC)  │  (Node.js)   │  (port 7225)  │ (Brave/Chrome)│
└─────────────┘                └─────────────┘                └──────┬──────┘
                                                                     │
                                                               chrome.* APIs
                                                               CDP protocol
                                                                     │
                                                              ┌──────▼──────┐
                                                              │   Browser    │
                                                              │    Tabs      │
                                                              └─────────────┘
```

## Why

Browser automation tools usually mean headless browsers, fake sessions, and fighting CAPTCHAs. claude-browser-bridge flips that — it connects Claude Code to your **real browser** where you're already logged in everywhere. Claude sees what you see and interacts with pages as you would.

## Quick Start

**1. Install the plugin**

Install via the softwaresoftware marketplace (installs this plugin and its dependencies):

```
/softwaresoftware:install claude-browser-bridge
```

The browser extension ships bundled with the plugin — no separate download.

**2. Load the extension into your browser**

Run the setup skill for guided instructions:

```
/claude-browser-bridge:setup
```

Or do it manually:

1. Open `brave://extensions` (or `chrome://extensions`, `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder inside the installed plugin directory
4. The Browser Bridge extension shows a green **ON** badge when connected

The plugin directory is at `~/.claude/plugins/cache/softwaresoftware-plugins/claude-browser-bridge/<version>/`.

**3. Use it**

Ask Claude to navigate to a page, fill a form, or take a screenshot. The daemon starts automatically on first tool use; the extension connects to it over WebSocket.

### Development install

To work on the plugin locally:

```bash
cd claude-browser-bridge
make install
claude --plugin-dir $(pwd)
```

Load the extension from `./extension/` using the same "Load unpacked" flow above.

## Tools

| Tool | Description |
|------|-------------|
| `list_tabs` | List all open tabs with IDs, URLs, and titles |
| `get_tab_info` | Get URL, title, and status of a specific tab |
| `screenshot` | Capture the visible tab as a PNG image |
| `get_page_content` | Get page text or full HTML |
| `navigate` | Navigate a tab to a URL and wait for load |
| `click` | Click an element by CSS selector |
| `type` | Type text into an input field |
| `eval_js` | Execute JavaScript in the page context (main world) |
| `fill_form` | Fill multiple form fields at once |
| `get_element_info` | Get attributes, text, and bounding box of an element |
| `wait_for` | Wait for a CSS selector to appear on the page |
| `scroll` | Scroll the page or a specific element |

All tools accept an optional `tab_id` parameter. Omit it to target the active tab.

## How It Works

**Trusted input via CDP.** Clicks and keystrokes aren't simulated with JavaScript events — they go through the Chrome DevTools Protocol as trusted input events. The browser treats them exactly like real user actions, so sites that detect synthetic events won't notice a difference.

**Persistent WebSocket connection.** The extension maintains a WebSocket connection to the local MCP server with automatic reconnection and exponential backoff (1s up to 30s). A keepalive alarm prevents the service worker from being killed by the browser.

**Main world execution.** `eval_js` runs code in the page's actual JavaScript context, not an isolated content script world. It can access page globals, call functions defined by the site, and interact with frameworks like React or Vue directly.

**Smart form filling.** `fill_form` dispatches both `input` and `change` events after setting values, so reactive frameworks (React, Angular, Vue) pick up the changes properly.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_BRIDGE_PORT` | `7225` | WebSocket port for extension connection |

**Timeouts:**
- Default tool timeout: 30 seconds
- `navigate`: 60 seconds (pages can be slow)
- `wait_for`: configurable per call (default 10 seconds)

## Limitations

- **No internal browser pages.** Extensions can't access `chrome://` or `brave://` URLs — the browser blocks it. If you need to interact with extension settings or browser config, do it manually.
- **Tab focus for screenshots.** Chrome requires the tab to be visible and focused to capture it. The extension handles this automatically, but the target tab will briefly flash to the foreground.
- **Single browser.** Connects to one browser instance at a time via the extension.

## Telemetry

The plugin sends anonymous tool-invocation events to `telemetry.softwaresoftware.dev` to help improve it. Each event contains:

- The tool name (e.g. `navigate`, `click`)
- A random per-session UUID
- Error messages, when a tool fails

**Nothing else is sent.** No page content, URLs, form values, selectors, or screenshots ever leave your machine.

**To opt out**, set the plugin's `telemetry_enabled` option to `false`:

```
claude plugin disable claude-browser-bridge
claude plugin enable claude-browser-bridge
# answer "false" when prompted for telemetry_enabled
```

## Project Structure

```
claude-browser-bridge/
├── server/
│   ├── index.js       # MCP client (per session, stdio)
│   ├── daemon.js      # Persistent daemon (WebSocket + IPC hub)
│   ├── tools.js       # Tool definitions with Zod schemas
│   ├── ipc.js         # IPC transport utilities
│   └── telemetry.js   # Usage telemetry
├── extension/         # Bundled browser extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js
│   └── icons/
├── skills/setup/      # /claude-browser-bridge:setup
├── hooks/             # Daemon auto-start hook
├── package.json
└── Makefile
```

## License

See [LICENSE](LICENSE).

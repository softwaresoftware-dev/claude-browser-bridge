# browser-bridge

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

Browser automation tools usually mean headless browsers, fake sessions, and fighting CAPTCHAs. browser-bridge flips that — it connects Claude Code to your **real browser** where you're already logged in everywhere. Claude sees what you see and interacts with pages as you would.

## Quick Start

**1. Install dependencies**

```bash
cd browser-bridge
make install
```

**2. Load the extension**

1. Open `brave://extensions` (or `chrome://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder

**3. Register the MCP server with Claude Code**

```bash
claude mcp add browser-bridge -- node /path/to/browser-bridge/server/index.js
```

Restart Claude Code. The extension connects automatically when the server starts.

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

## Project Structure

```
browser-bridge/
├── extension/
│   ├── background.js       # Service worker — WebSocket client, all browser actions
│   ├── manifest.json        # Manifest v3 with debugger + scripting permissions
│   └── icons/               # Extension icons
├── server/
│   ├── index.js             # MCP server + WebSocket server
│   └── tools.js             # Tool definitions with Zod schemas
├── package.json
└── Makefile
```

## License

MIT

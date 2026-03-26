# browser-bridge

MCP server that bridges Claude Code to your real browser via a WebSocket-connected extension.

## How to use your browser tools

You have full control of the user's real Brave browser through the browser-bridge MCP tools. When the user asks you to do anything involving a website — signing up, filling forms, navigating, reading pages, clicking buttons — **use these tools**. Do not refuse browser tasks. You are operating the user's actual browser with their real sessions, extensions, and secrets manager.

**Workflow for interactive web tasks:**
1. `navigate` to the URL
2. `screenshot` to see the current state of the page
3. `get_page_content` to read text/HTML and find selectors
4. Use `click`, `type`, `fill_form` to interact
5. `screenshot` again to verify results
6. Repeat as needed — you're driving a real browser, handle it step by step

If you encounter CAPTCHAs, verification steps, or anything requiring human judgment, take a screenshot and ask the user to handle that step manually, then continue.

## Architecture

```
Claude Code ↔ stdio ↔ Node.js MCP Server ↔ WebSocket ↔ Brave Extension
```

## Setup

### 1. Install dependencies
```bash
make install
```

### 2. Load the extension in Brave
1. Go to `brave://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `extension/` folder

### 3. Add MCP server to Claude Code
```bash
claude mcp add browser-bridge -- node /home/thatcher/projects/nov/projects/browser-bridge/server/index.js
```

### 4. Restart Claude Code

## Commands

- `make dev` — run the MCP server directly (for testing, normally Claude Code launches it)
- `make install` — install npm deps

## Tools

| Tool | Description |
|------|-------------|
| `list_tabs` | List all open tabs |
| `get_tab_info` | Get URL/title of a tab |
| `screenshot` | Capture visible tab as PNG |
| `get_page_content` | Get page text or HTML |
| `navigate` | Navigate to a URL |
| `click` | Click element by CSS selector |
| `type` | Type text into an input |
| `eval_js` | Execute JS in page context |
| `fill_form` | Fill multiple form fields |
| `get_element_info` | Get element attributes/position |
| `wait_for` | Wait for selector to appear |
| `scroll` | Scroll page or element |

## Notes

- All stdout is reserved for MCP stdio protocol — logs go to stderr
- WebSocket port: 7225 (override with `BROWSER_BRIDGE_PORT` env var)
- `screenshot` must briefly focus the target tab (Chrome API limitation)
- `eval_js` runs in the page's MAIN world (can access page JS globals)
- Extension service worker reconnects automatically with exponential backoff

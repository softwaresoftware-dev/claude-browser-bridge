import { z } from "zod";
import { sendEvent } from "./telemetry.js";

function renderOutline(result) {
  const header = [
    `url: ${result.url}`,
    `title: ${result.title}`,
    `viewport: ${result.viewport.w}x${result.viewport.h}  scroll: ${result.scroll.y}/${result.scroll.maxY}`,
    "",
  ];
  const lines = [];
  function walk(node, depth) {
    const indent = "  ".repeat(depth);
    const parts = [`[${node.id}]`, node.role || node.tag];
    if (node.level != null) parts.push(`level=${node.level}`);
    if (node.input_type) parts.push(`type=${node.input_type}`);
    if (node.name) parts.push(JSON.stringify(node.name));
    if (node.value != null) parts.push(`value=${JSON.stringify(node.value)}`);
    if (node.href) parts.push(`→ ${node.href}`);
    if (node.state) {
      const flags = [];
      for (const [k, v] of Object.entries(node.state)) {
        flags.push(v === true ? k : `${k}=${v}`);
      }
      if (flags.length) parts.push(`(${flags.join(" ")})`);
    }
    if (node.in_viewport === false) parts.push("(off-screen)");
    lines.push(indent + parts.join(" "));
    if (node.text_only) {
      lines.push(indent + `  · ${node.text_only}`);
    }
    if (node.children) {
      for (const c of node.children) walk(c, depth + 1);
    }
  }
  for (const top of result.tree) walk(top, 0);
  return header.concat(lines).join("\n");
}

export function registerTools(server, send, getWarning = () => null) {
  // Append version warning to tool response content if present
  function withWarning(content) {
    const warning = getWarning();
    if (!warning) return content;
    return [...content, { type: "text", text: `\n⚠️ ${warning}` }];
  }

  server.tool(
    "list_tabs",
    "List open browser tabs (scoped to this session's tab group by default)",
    {
      all_tabs: z.boolean().optional().describe("Show all tabs across all sessions, not just this session's group"),
    },
    async ({ all_tabs }) => {
      sendEvent("tool_invoked", { tool: "list_tabs" });
      try {
        const tabs = await send("list_tabs", { all_tabs });
        return { content: withWarning([{ type: "text", text: JSON.stringify(tabs, null, 2) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "list_tabs", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "close_session_tabs",
    "Close every tab this session opened (its tab group) — call when you're done with the browser",
    {},
    async () => {
      sendEvent("tool_invoked", { tool: "close_session_tabs" });
      try {
        const result = await send("close_session_tabs", {});
        return { content: withWarning([{ type: "text", text: `Closed ${result.closed} tab(s)` }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "close_session_tabs", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "close_tab",
    "Close one tab by id — use it to tidy up any tab you opened and no longer need (a page you navigated to, a preview, a login flow). Prefer this over leaving tabs behind.",
    {
      tab_id: z.number().describe("Tab ID (from list_tabs / navigate)"),
    },
    async ({ tab_id }) => {
      sendEvent("tool_invoked", { tool: "close_tab" });
      try {
        const r = await send("close_tab", { tab_id });
        return { content: withWarning([{ type: "text", text: r.closed ? `Closed tab ${tab_id}` : `Tab ${tab_id} not closed: ${r.reason || "unknown"}` }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "close_tab", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "close_tab_groups",
    "Close Claude tab groups left behind by other sessions. By default closes every group marked '(ended)'; pass title_pattern to match a substring of the group title instead (e.g. a session id)",
    {
      title_pattern: z.string().optional().describe("Substring the group title must contain (default: '(ended)')"),
    },
    async ({ title_pattern }) => {
      sendEvent("tool_invoked", { tool: "close_tab_groups" });
      try {
        const r = await send("close_tab_groups", { title_pattern });
        return { content: withWarning([{ type: "text", text: `Closed ${r.groups} group(s), ${r.tabs} tab(s): ${r.titles.join(", ") || "none"}` }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "close_tab_groups", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "get_tab_info",
    "Get info about a specific tab (defaults to active tab)",
    { tab_id: z.number().optional().describe("Tab ID, omit for active tab") },
    async ({ tab_id }) => {
      sendEvent("tool_invoked", { tool: "get_tab_info" });
      try {
        const info = await send("get_tab_info", { tab_id });
        return { content: withWarning([{ type: "text", text: JSON.stringify(info, null, 2) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "get_tab_info", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "screenshot",
    "Take a screenshot of a tab (defaults to active tab). Returns base64 PNG.",
    { tab_id: z.number().optional().describe("Tab ID, omit for active tab") },
    async ({ tab_id }) => {
      sendEvent("tool_invoked", { tool: "screenshot" });
      try {
        const base64 = await send("screenshot", { tab_id });
        return {
          content: withWarning([{ type: "image", data: base64, mimeType: "image/png" }]),
        };
      } catch (err) {
        sendEvent("tool_error", { tool: "screenshot", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "get_page_content",
    "Get the text or HTML content of a page",
    {
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
      format: z.enum(["text", "html"]).default("text").describe("Return format"),
    },
    async ({ tab_id, format }) => {
      sendEvent("tool_invoked", { tool: "get_page_content" });
      try {
        const content = await send("get_page_content", { tab_id, format });
        return { content: withWarning([{ type: "text", text: content }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "get_page_content", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "navigate",
    "Navigate a tab to a URL",
    {
      url: z.string().describe("URL to navigate to"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ url, tab_id }) => {
      sendEvent("tool_invoked", { tool: "navigate" });
      try {
        const result = await send("navigate", { tab_id, url }, 60000);
        return { content: withWarning([{ type: "text", text: JSON.stringify(result) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "navigate", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "click",
    "Click an element. Most robust: `role`+`name` (accessibility tree — spans shadow DOM/iframes, survives DOM churn on hostile SPAs). Or `id` from observe, or a CSS `selector`.",
    {
      id: z.string().optional().describe('Element id from observe, e.g. "0-12"'),
      selector: z.string().optional().describe("CSS selector (use when no id is available)"),
      role: z.string().optional().describe('ARIA role, e.g. "button", "textbox", "link" — pair with name'),
      name: z.string().optional().describe("Accessible name (exact, falls back to substring match)"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ id, selector, role, name, tab_id }) => {
      sendEvent("tool_invoked", { tool: "click" });
      try {
        const result = await send("click", { tab_id, id, selector, role, name });
        return { content: withWarning([{ type: "text", text: JSON.stringify(result) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "click", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "type",
    "Type text into an element (newlines become real Enter presses). Most robust: `role`+`name` (accessibility tree). Or `id` from observe, or a CSS `selector`.",
    {
      id: z.string().optional().describe('Element id from observe, e.g. "0-12"'),
      selector: z.string().optional().describe("CSS selector (use when no id is available)"),
      role: z.string().optional().describe('ARIA role, e.g. "textbox" — pair with name'),
      name: z.string().optional().describe("Accessible name (exact, falls back to substring match)"),
      text: z.string().describe("Text to type; \\n produces a real line break"),
      clear: z.boolean().default(true).describe("Clear existing value first"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ id, selector, role, name, text, clear, tab_id }) => {
      sendEvent("tool_invoked", { tool: "type" });
      try {
        const result = await send("type", { tab_id, id, selector, role, name, text, clear });
        return { content: withWarning([{ type: "text", text: JSON.stringify(result) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "type", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "press_key",
    "Press a keyboard key in the focused element — Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/PageDown, or a single character. Supports modifiers (e.g. Control+a to select all).",
    {
      key: z.string().describe('Key to press: named key ("Enter", "Tab", "Escape", ...) or single character ("a")'),
      modifiers: z.array(z.enum(["Control", "Alt", "Shift", "Meta"])).optional().describe("Held modifiers"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ key, modifiers, tab_id }) => {
      sendEvent("tool_invoked", { tool: "press_key" });
      try {
        const result = await send("press_key", { tab_id, key, modifiers });
        return { content: withWarning([{ type: "text", text: JSON.stringify(result) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "press_key", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "reload_extension",
    "Reload the browser extension from disk (development). Use after editing extension code — a browser restart alone can serve stale cached scripts.",
    {},
    async () => {
      sendEvent("tool_invoked", { tool: "reload_extension" });
      try {
        const result = await send("reload_extension", {});
        return { content: withWarning([{ type: "text", text: JSON.stringify(result) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "reload_extension", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "observe",
    "Snapshot the page: screenshot + numbered interactive elements + URL/scroll state in one call. Each element has a stable `id` (e.g. \"0-12\") usable with click/type. Prefer this over screenshot+get_page_content+get_element_info.",
    {
      viewport_only: z.boolean().default(false).describe("Return only elements currently in the viewport"),
      include_screenshot: z.boolean().default(true).describe("Include a PNG screenshot in the response"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ viewport_only, include_screenshot, tab_id }) => {
      sendEvent("tool_invoked", { tool: "observe" });
      try {
        const result = await send("observe", { tab_id, viewport_only, include_screenshot });
        const { screenshot, screenshot_error, ...state } = result;
        const content = [];
        if (screenshot) {
          content.push({ type: "image", data: screenshot, mimeType: "image/png" });
        }
        if (screenshot_error) {
          state.screenshot_error = screenshot_error;
        }
        content.push({ type: "text", text: JSON.stringify(state) });
        return { content: withWarning(content) };
      } catch (err) {
        sendEvent("tool_error", { tool: "observe", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "observe_a11y",
    "Fast text-only semantic snapshot. Returns a hierarchical outline of interactive + landmark elements with stable `id` refs (usable with click/type) and a `text_only` field per node capturing surrounding non-interactive text. No screenshot — ~10x smaller than `observe` and much faster for multi-step form/navigation flows. Refs persist across calls as long as the DOM node exists.",
    {
      viewport_only: z.boolean().default(false).describe("Return only elements currently in the viewport"),
      max_depth: z.number().default(60).describe("Max DOM tree depth to walk"),
      format: z.enum(["outline", "json"]).default("outline").describe("outline = indented text (compact, Claude-friendly); json = raw tree"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ viewport_only, max_depth, format, tab_id }) => {
      sendEvent("tool_invoked", { tool: "observe_a11y" });
      try {
        const result = await send("observe_a11y", { tab_id, viewport_only, max_depth });
        if (format === "json") {
          return { content: withWarning([{ type: "text", text: JSON.stringify(result, null, 2) }]) };
        }
        return { content: withWarning([{ type: "text", text: renderOutline(result) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "observe_a11y", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "eval_js",
    "Execute JavaScript in the page context and return the result",
    {
      code: z.string().optional().describe("JavaScript code to execute"),
      expression: z.string().optional().describe("Alias for code"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async (params) => {
      sendEvent("tool_invoked", { tool: "eval_js" });
      try {
        const code = params.code || params.expression;
        const tab_id = params.tab_id;
        if (!code) throw new Error("Missing 'code' (or 'expression') parameter");
        const result = await send("eval_js", { tab_id, code });
        return { content: withWarning([{ type: "text", text: JSON.stringify(result, null, 2) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "eval_js", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "fill_form",
    "Fill multiple form fields at once",
    {
      fields: z
        .array(z.object({
          selector: z.string().describe("CSS selector for the field"),
          value: z.string().describe("Value to fill"),
        }))
        .describe("Array of {selector, value} pairs"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ fields, tab_id }) => {
      sendEvent("tool_invoked", { tool: "fill_form" });
      try {
        const result = await send("fill_form", { tab_id, fields });
        return { content: withWarning([{ type: "text", text: JSON.stringify(result, null, 2) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "fill_form", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "get_element_info",
    "Get attributes, text, and bounding box of an element",
    {
      selector: z.string().describe("CSS selector for the element"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ selector, tab_id }) => {
      sendEvent("tool_invoked", { tool: "get_element_info" });
      try {
        const info = await send("get_element_info", { tab_id, selector });
        return { content: withWarning([{ type: "text", text: JSON.stringify(info, null, 2) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "get_element_info", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "wait_for",
    "Wait for an element to appear — by CSS selector, or by accessibility role/name (robust on shadow DOM, iframes, hostile SPAs)",
    {
      selector: z.string().optional().describe("CSS selector to wait for"),
      role: z.string().optional().describe('ARIA role, e.g. "textbox" — pair with name'),
      name: z.string().optional().describe("Accessible name (exact, falls back to substring match)"),
      timeout: z.number().default(10000).describe("Max wait time in ms"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ selector, role, name, timeout, tab_id }) => {
      sendEvent("tool_invoked", { tool: "wait_for" });
      try {
        const result = await send("wait_for", { tab_id, selector, role, name, timeout }, timeout + 5000);
        return { content: withWarning([{ type: "text", text: JSON.stringify(result) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "wait_for", error: err.message });
        throw err;
      }
    }
  );

  server.tool(
    "scroll",
    "Scroll the page or a specific element",
    {
      x: z.number().default(0).describe("Horizontal scroll amount in pixels"),
      y: z.number().default(0).describe("Vertical scroll amount in pixels"),
      selector: z.string().optional().describe("CSS selector to scroll within, omit for page"),
      behavior: z.enum(["smooth", "instant"]).default("instant"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ x, y, selector, behavior, tab_id }) => {
      sendEvent("tool_invoked", { tool: "scroll" });
      try {
        const result = await send("scroll", { tab_id, x, y, selector, behavior });
        return { content: withWarning([{ type: "text", text: JSON.stringify(result) }]) };
      } catch (err) {
        sendEvent("tool_error", { tool: "scroll", error: err.message });
        throw err;
      }
    }
  );
}

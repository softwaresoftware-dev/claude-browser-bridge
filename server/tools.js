import { z } from "zod";

export function registerTools(server, send) {
  server.tool(
    "list_tabs",
    "List open browser tabs (scoped to this session's tab group by default)",
    {
      all_tabs: z.boolean().optional().describe("Show all tabs across all sessions, not just this session's group"),
    },
    async ({ all_tabs }) => {
      const tabs = await send("list_tabs", { all_tabs });
      return { content: [{ type: "text", text: JSON.stringify(tabs, null, 2) }] };
    }
  );

  server.tool(
    "get_tab_info",
    "Get info about a specific tab (defaults to active tab)",
    { tab_id: z.number().optional().describe("Tab ID, omit for active tab") },
    async ({ tab_id }) => {
      const info = await send("get_tab_info", { tab_id });
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
  );

  server.tool(
    "screenshot",
    "Take a screenshot of a tab (defaults to active tab). Returns base64 PNG.",
    { tab_id: z.number().optional().describe("Tab ID, omit for active tab") },
    async ({ tab_id }) => {
      const base64 = await send("screenshot", { tab_id });
      return {
        content: [{ type: "image", data: base64, mimeType: "image/png" }],
      };
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
      const content = await send("get_page_content", { tab_id, format });
      return { content: [{ type: "text", text: content }] };
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
      const result = await send("navigate", { tab_id, url }, 60000);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "click",
    "Click an element by CSS selector",
    {
      selector: z.string().describe("CSS selector for the element to click"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ selector, tab_id }) => {
      const result = await send("click", { tab_id, selector });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "type",
    "Type text into an element by CSS selector",
    {
      selector: z.string().describe("CSS selector for the input element"),
      text: z.string().describe("Text to type"),
      clear: z.boolean().default(true).describe("Clear existing value first"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ selector, text, clear, tab_id }) => {
      const result = await send("type", { tab_id, selector, text, clear });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
      const code = params.code || params.expression;
      const tab_id = params.tab_id;
      if (!code) throw new Error("Missing 'code' (or 'expression') parameter");
      const result = await send("eval_js", { tab_id, code });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
      const result = await send("fill_form", { tab_id, fields });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
      const info = await send("get_element_info", { tab_id, selector });
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
  );

  server.tool(
    "wait_for",
    "Wait for a CSS selector to appear on the page",
    {
      selector: z.string().describe("CSS selector to wait for"),
      timeout: z.number().default(10000).describe("Max wait time in ms"),
      tab_id: z.number().optional().describe("Tab ID, omit for active tab"),
    },
    async ({ selector, timeout, tab_id }) => {
      const result = await send("wait_for", { tab_id, selector, timeout }, timeout + 5000);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
      const result = await send("scroll", { tab_id, x, y, selector, behavior });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}

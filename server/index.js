#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { registerTools } from "./tools.js";

const PORT = parseInt(process.env.BROWSER_BRIDGE_PORT || "7225", 10);
const DEFAULT_TIMEOUT = 30000;

let extensionSocket = null;
const pending = new Map();

// --- WebSocket server (talks to browser extension) ---

const wss = new WebSocketServer({ port: PORT });
const log = (...args) => process.stderr.write(args.join(" ") + "\n");

wss.on("listening", () => {
  log(`[browser-bridge] WebSocket server listening on ws://localhost:${PORT}`);
});

wss.on("connection", (ws) => {
  log("[browser-bridge] Extension connected");
  extensionSocket = ws;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log("[browser-bridge] Bad message from extension:", raw.toString());
      return;
    }

    const entry = pending.get(msg.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    pending.delete(msg.id);

    if (msg.success) {
      entry.resolve(msg.data);
    } else {
      entry.reject(new Error(msg.error || "Unknown extension error"));
    }
  });

  ws.on("close", () => {
    log("[browser-bridge] Extension disconnected");
    extensionSocket = null;
  });

  ws.on("error", (err) => {
    log("[browser-bridge] WebSocket error:", err.message);
  });

  // keepalive ping every 20s
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 20000);

  ws.on("close", () => clearInterval(pingInterval));
});

function sendToExtension(action, params = {}, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
      reject(new Error("Browser extension not connected. Load the extension in Brave and make sure the browser is running."));
      return;
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Request timed out after ${timeout}ms (action: ${action})`));
    }, timeout);

    pending.set(id, { resolve, reject, timer });

    extensionSocket.send(JSON.stringify({ id, action, params }));
  });
}

// --- MCP server (talks to Claude Code via stdio) ---

const mcp = new McpServer({
  name: "browser-bridge",
  version: "1.0.0",
});

registerTools(mcp, sendToExtension);

const transport = new StdioServerTransport();
await mcp.connect(transport);

log("[browser-bridge] MCP server connected via stdio");

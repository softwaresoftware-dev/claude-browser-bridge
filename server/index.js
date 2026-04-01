#!/usr/bin/env node

/**
 * Browser-bridge MCP client — thin passthrough that connects to the daemon
 * via IPC and exposes browser tools over stdio to Claude Code.
 *
 * The daemon (daemon.js) owns the WebSocket connection to the browser extension.
 * This process just relays tool calls to the daemon and returns responses.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createConnection } from "net";
import { randomUUID } from "crypto";
import { registerTools } from "./tools.js";
import { getIpcAddress, createNdjsonParser, sendNdjson } from "./ipc.js";

const DEFAULT_TIMEOUT = 30000;
const log = (...args) => process.stderr.write(args.join(" ") + "\n");

// --- IPC client (talks to daemon) ---

const pending = new Map(); // requestId → { resolve, reject, timer }
const ipcAddress = getIpcAddress();
let ipcSocket = null;

function connectToDaemon() {
  return new Promise((resolve, reject) => {
    const socket = createConnection(ipcAddress);

    socket.on("connect", () => {
      log(`[browser-bridge] Connected to daemon at ${ipcAddress}`);
      ipcSocket = socket;
      resolve(socket);
    });

    socket.on("data", createNdjsonParser((msg) => {
      if (msg.type === "response") {
        const entry = pending.get(msg.requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(msg.requestId);
        if (msg.success) {
          entry.resolve(msg.data);
        } else {
          entry.reject(new Error(msg.error || "Unknown daemon error"));
        }
      } else if (msg.type === "status") {
        log(`[browser-bridge] Extension connected: ${msg.extensionConnected}`);
      }
    }));

    socket.on("close", () => {
      log("[browser-bridge] Disconnected from daemon");
      ipcSocket = null;
      // Reject all pending requests
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(new Error("Daemon connection lost"));
      }
    });

    socket.on("error", (err) => {
      if (!ipcSocket) {
        // Connection failed
        reject(new Error(
          `Cannot connect to browser-bridge daemon at ${ipcAddress}. ` +
          `Use the daemon_start tool to start it: daemon_start("claude-browser-bridge", "node", ` +
          `["server/daemon.js"], cwd="/path/to/claude-browser-bridge")`
        ));
      } else {
        log("[browser-bridge] IPC error:", err.message);
      }
    });
  });
}

function sendToDaemon(action, params = {}, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!ipcSocket || ipcSocket.destroyed) {
      reject(new Error(
        "Not connected to browser-bridge daemon. " +
        "Use the daemon_start tool to start it."
      ));
      return;
    }

    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Request timed out after ${timeout}ms (action: ${action})`));
    }, timeout);

    pending.set(requestId, { resolve, reject, timer });

    sendNdjson(ipcSocket, {
      type: "request",
      requestId,
      action,
      params,
      timeout,
    });
  });
}

// --- Startup ---

try {
  await connectToDaemon();
} catch (err) {
  log(`[browser-bridge] ${err.message}`);
  // Still start the MCP server so Claude gets the error message from tool calls
  // rather than the MCP server failing to start entirely
}

const mcp = new McpServer({
  name: "claude-browser-bridge",
  version: "2.0.0",
});

registerTools(mcp, sendToDaemon);

const transport = new StdioServerTransport();
await mcp.connect(transport);

log("[browser-bridge] MCP server connected via stdio");

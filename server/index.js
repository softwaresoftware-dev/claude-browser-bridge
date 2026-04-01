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
const RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 10000;
const log = (...args) => process.stderr.write(args.join(" ") + "\n");

// --- IPC client (talks to daemon) ---

const pending = new Map(); // requestId → { resolve, reject, timer }
const ipcAddress = getIpcAddress();
let ipcSocket = null;
let reconnecting = false;
let reconnectDelay = RECONNECT_DELAY;

function connectToDaemon() {
  return new Promise((resolve, reject) => {
    const socket = createConnection(ipcAddress);

    socket.on("connect", () => {
      log(`[browser-bridge] Connected to daemon at ${ipcAddress}`);
      ipcSocket = socket;
      reconnectDelay = RECONNECT_DELAY;
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
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(new Error("Daemon connection lost"));
      }
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      if (!ipcSocket) {
        reject(new Error(`Cannot connect to daemon at ${ipcAddress}`));
      } else {
        log("[browser-bridge] IPC error:", err.message);
      }
    });
  });
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  log(`[browser-bridge] Reconnecting in ${reconnectDelay}ms...`);
  setTimeout(async () => {
    reconnecting = false;
    try {
      await connectToDaemon();
    } catch {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      scheduleReconnect();
    }
  }, reconnectDelay);
}

async function ensureConnected() {
  if (ipcSocket && !ipcSocket.destroyed) return;
  // Try one immediate connect attempt
  try {
    await connectToDaemon();
  } catch {
    throw new Error(
      "Not connected to browser-bridge daemon. " +
      "Use the daemon_start tool to start it, then retry."
    );
  }
}

function sendToDaemon(action, params = {}, timeout = DEFAULT_TIMEOUT) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureConnected();
    } catch (err) {
      reject(err);
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
} catch {
  log("[browser-bridge] Daemon not running — will connect when available");
}

const mcp = new McpServer({
  name: "claude-browser-bridge",
  version: "2.0.0",
});

registerTools(mcp, sendToDaemon);

const transport = new StdioServerTransport();
await mcp.connect(transport);

log("[browser-bridge] MCP server connected via stdio");

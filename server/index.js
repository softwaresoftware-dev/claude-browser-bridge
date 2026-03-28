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

const log = (...args) => process.stderr.write(args.join(" ") + "\n");

const wss = await new Promise((resolve, reject) => {
  const server = new WebSocketServer({ port: PORT });
  server.on("listening", () => {
    log(`[claude-browser-bridge] WebSocket server listening on ws://localhost:${PORT}`);
    resolve(server);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(`[claude-browser-bridge] Port ${PORT} in use, killing stale process...`);
      import("child_process").then(({ execSync }) => {
        try {
          const pid = execSync(`lsof -ti :${PORT}`, { encoding: "utf8" }).trim();
          if (pid) {
            for (const p of pid.split("\n")) {
              log(`[claude-browser-bridge] Killing PID ${p}`);
              process.kill(parseInt(p), "SIGTERM");
            }
          }
        } catch { /* no process found */ }

        // Retry after a brief delay
        setTimeout(() => {
          const retry = new WebSocketServer({ port: PORT });
          retry.on("listening", () => {
            log(`[claude-browser-bridge] WebSocket server listening on ws://localhost:${PORT} (after retry)`);
            resolve(retry);
          });
          retry.on("error", (retryErr) => reject(retryErr));
        }, 500);
      });
    } else {
      reject(err);
    }
  });
});

wss.on("connection", (ws) => {
  if (extensionSocket && extensionSocket.readyState === extensionSocket.OPEN) {
    log("[claude-browser-bridge] New extension connection replacing existing one");
    extensionSocket.close();
  }
  log("[claude-browser-bridge] Extension connected");
  extensionSocket = ws;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log("[claude-browser-bridge] Bad message from extension:", raw.toString());
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
    log("[claude-browser-bridge] Extension disconnected");
    if (extensionSocket === ws) extensionSocket = null;

    // Reject all pending requests — the extension that would have answered them is gone.
    // This gives Claude an immediate error instead of waiting for individual timeouts.
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error("Browser extension disconnected while request was in flight"));
    }
  });

  ws.on("error", (err) => {
    log("[claude-browser-bridge] WebSocket error:", err.message);
  });

  // keepalive ping every 20s with dead connection detection
  let pongReceived = true;
  ws.on("pong", () => { pongReceived = true; });

  const pingInterval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;

    if (!pongReceived) {
      log("[claude-browser-bridge] No pong received, terminating dead connection");
      ws.terminate();
      return;
    }

    pongReceived = false;
    ws.ping();
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
  name: "claude-browser-bridge",
  version: "1.0.0",
});

registerTools(mcp, sendToExtension);

const transport = new StdioServerTransport();
await mcp.connect(transport);

log("[claude-browser-bridge] MCP server connected via stdio");

#!/usr/bin/env node

/**
 * Browser-bridge daemon — persistent process that owns the WebSocket connection
 * to the browser extension and multiplexes requests from N MCP client processes
 * over IPC (Unix socket / named pipe).
 *
 * Started by daemon-manager. Not run directly by Claude Code.
 */

import { WebSocketServer } from "ws";
import { createServer as createNetServer } from "net";
import { unlinkSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { getIpcAddress, createNdjsonParser, sendNdjson, PORT } from "./ipc.js";

const log = (...args) => process.stderr.write(args.join(" ") + "\n");

// --- State ---
let extensionSocket = null;
const pending = new Map(); // requestId → { clientSocket, timer }
const clients = new Set(); // connected IPC client sockets

// --- WebSocket server (talks to browser extension) ---

const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  log(`[daemon] WebSocket server listening on ws://localhost:${PORT}`);
});

wss.on("error", (err) => {
  log(`[daemon] WebSocket server error: ${err.message}`);
  process.exit(1);
});

wss.on("connection", (ws) => {
  if (extensionSocket && extensionSocket.readyState === extensionSocket.OPEN) {
    log("[daemon] New extension connection replacing existing one");
    extensionSocket.close();
  }
  log("[daemon] Extension connected");
  extensionSocket = ws;

  // Notify all IPC clients
  broadcastStatus();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log("[daemon] Bad message from extension:", raw.toString());
      return;
    }

    const entry = pending.get(msg.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    pending.delete(msg.id);

    sendNdjson(entry.clientSocket, {
      type: "response",
      requestId: entry.clientRequestId,
      success: msg.success,
      ...(msg.success ? { data: msg.data } : { error: msg.error || "Unknown extension error" }),
    });
  });

  ws.on("close", () => {
    log("[daemon] Extension disconnected");
    if (extensionSocket === ws) extensionSocket = null;

    // Reject all pending requests
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      sendNdjson(entry.clientSocket, {
        type: "response",
        requestId: entry.clientRequestId,
        success: false,
        error: "Browser extension disconnected while request was in flight",
      });
    }

    broadcastStatus();
  });

  ws.on("error", (err) => {
    log("[daemon] WebSocket error:", err.message);
  });

  // Keepalive ping every 20s
  let pongReceived = true;
  ws.on("pong", () => { pongReceived = true; });

  const pingInterval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!pongReceived) {
      log("[daemon] No pong received, terminating dead connection");
      ws.terminate();
      return;
    }
    pongReceived = false;
    ws.ping();
  }, 20000);

  ws.on("close", () => clearInterval(pingInterval));
});

// --- IPC server (talks to MCP client processes) ---

const ipcAddress = getIpcAddress();

// Clean up stale socket file
if (existsSync(ipcAddress) && !ipcAddress.startsWith("\\\\.\\pipe\\")) {
  unlinkSync(ipcAddress);
}

const ipcServer = createNetServer((socket) => {
  log("[daemon] IPC client connected");
  clients.add(socket);

  // Send initial status
  sendNdjson(socket, {
    type: "status",
    extensionConnected: !!(extensionSocket && extensionSocket.readyState === extensionSocket.OPEN),
  });

  const onMessage = (msg) => {
    if (msg.type !== "request") return;

    const { requestId, action, params, timeout } = msg;

    if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
      sendNdjson(socket, {
        type: "response",
        requestId,
        success: false,
        error: "Browser extension not connected. Load the extension in Brave and make sure the browser is running.",
      });
      return;
    }

    // Generate a unique ID for the extension request (maps back via requestId)
    const extId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(extId);
      sendNdjson(socket, {
        type: "response",
        requestId,
        success: false,
        error: `Request timed out after ${timeout || 30000}ms (action: ${action})`,
      });
    }, timeout || 30000);

    // Store with the extension ID as key, but include the client's requestId for response routing
    pending.set(extId, { clientSocket: socket, timer, clientRequestId: requestId });

    extensionSocket.send(JSON.stringify({ id: extId, action, params }));
  };

  socket.on("data", createNdjsonParser(onMessage));

  socket.on("close", () => {
    log("[daemon] IPC client disconnected");
    clients.delete(socket);

    // Clean up pending requests from this client
    for (const [id, entry] of pending) {
      if (entry.clientSocket === socket) {
        clearTimeout(entry.timer);
        pending.delete(id);
      }
    }
  });

  socket.on("error", (err) => {
    log("[daemon] IPC client error:", err.message);
  });
});

ipcServer.listen(ipcAddress, () => {
  log(`[daemon] IPC server listening on ${ipcAddress}`);
});

ipcServer.on("error", (err) => {
  log(`[daemon] IPC server error: ${err.message}`);
  process.exit(1);
});

// --- Utilities ---

function broadcastStatus() {
  const status = {
    type: "status",
    extensionConnected: !!(extensionSocket && extensionSocket.readyState === extensionSocket.OPEN),
  };
  for (const client of clients) {
    sendNdjson(client, status);
  }
}

// --- Cleanup on exit ---

function cleanup() {
  log("[daemon] Shutting down...");
  // Close IPC server and clean up socket file
  ipcServer.close();
  if (!ipcAddress.startsWith("\\\\.\\pipe\\")) {
    try { unlinkSync(ipcAddress); } catch { /* already gone */ }
  }
  // Close WebSocket server
  wss.close();
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

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
import { createServer as createHttpServer } from "http";
import { unlinkSync, existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { getIpcAddress, createNdjsonParser, sendNdjson, PORT } from "./ipc.js";
import { createLogger } from "./logger.js";

const log = createLogger("daemon");

// --- State ---
let extensionSocket = null;
let extensionVersionWarning = null; // null if versions match, string message if outdated
const pending = new Map(); // requestId → { clientSocket, timer }
const clients = new Map(); // socket → { sessionId }

// Read the bundled extension version so we can detect outdated installs.
// The daemon is started with cwd set to the plugin root, so extension/ is relative to cwd.
let expectedExtensionVersion = null;
try {
  const manifestPath = join(process.cwd(), "extension", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  expectedExtensionVersion = manifest.version;
  log.info(`Expected extension version: ${expectedExtensionVersion}`);
} catch {
  log.warn("Could not read bundled extension manifest — version check disabled");
}

// --- WebSocket server (talks to browser extension) ---
// Use an HTTP server to handle Private Network Access (PNA) preflight requests.
// Chrome/Brave extensions must pass a PNA check before connecting to localhost
// via WebSocket. Without this, the browser sends an OPTIONS preflight that the
// bare ws library can't answer, and the connection silently fails.

const httpServer = createHttpServer((req, res) => {
  // Handle PNA preflight (and general CORS preflight)
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Private-Network": "true",
    });
    res.end();
    return;
  }
  res.writeHead(426); // Upgrade Required
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, "127.0.0.1", () => {
  log.info(`WebSocket server listening on ws://127.0.0.1:${PORT}`);
});

httpServer.on("error", (err) => {
  log.error(`HTTP/WebSocket server error: ${err.message}`);
  process.exit(1);
});

wss.on("connection", (ws) => {
  if (extensionSocket && extensionSocket.readyState === extensionSocket.OPEN) {
    log.info("New extension connection replacing existing one");
    extensionSocket.close();
  }
  log.info("Extension connected");
  extensionSocket = ws;
  extensionVersionWarning = null;

  // Send expected version so the extension can compare
  if (expectedExtensionVersion) {
    ws.send(JSON.stringify({ type: "version_check", expectedVersion: expectedExtensionVersion }));
  }

  // Notify all IPC clients
  broadcastStatus();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log.warn("Bad message from extension:", raw.toString());
      return;
    }

    // Handle version report from extension
    if (msg.type === "version_report") {
      if (msg.outdated) {
        extensionVersionWarning =
          `Browser extension is v${msg.currentVersion} but v${msg.expectedVersion} is available. ` +
          `Reload the extension from your browser's extensions page (the updated code is at the same path).`;
        log.warn(`Extension version mismatch: loaded=${msg.currentVersion}, expected=${msg.expectedVersion}`);
        broadcastStatus();
      } else {
        extensionVersionWarning = null;
        log.info(`Extension version OK: ${msg.currentVersion}`);
      }
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
      ...(extensionVersionWarning ? { warning: extensionVersionWarning } : {}),
    });
  });

  ws.on("close", () => {
    log.warn("Extension disconnected");
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
    log.error("WebSocket error:", err.message);
  });

  // Keepalive ping every 20s
  let pongReceived = true;
  ws.on("pong", () => { pongReceived = true; });

  const pingInterval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!pongReceived) {
      log.warn("No pong received, terminating dead connection");
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
  log.debug("IPC client connected");
  clients.set(socket, { sessionId: null });

  // Send initial status
  sendNdjson(socket, {
    type: "status",
    extensionConnected: !!(extensionSocket && extensionSocket.readyState === extensionSocket.OPEN),
  });

  const onMessage = (msg) => {
    if (msg.type === "hello") {
      clients.set(socket, { sessionId: msg.sessionId });
      log.info(`IPC client identified as session ${msg.sessionId}`);
      return;
    }

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

    const clientInfo = clients.get(socket);
    extensionSocket.send(JSON.stringify({ id: extId, action, params, sessionId: clientInfo?.sessionId }));
  };

  socket.on("data", createNdjsonParser(onMessage));

  socket.on("close", () => {
    const clientInfo = clients.get(socket);
    const sid = clientInfo?.sessionId;
    log.debug(`IPC client disconnected (session ${sid || "unknown"})`);
    clients.delete(socket);

    // Notify extension so it can mark the tab group as ended
    if (sid && extensionSocket && extensionSocket.readyState === extensionSocket.OPEN) {
      extensionSocket.send(JSON.stringify({ type: "session_end", sessionId: sid }));
    }

    // Clean up pending requests from this client
    for (const [id, entry] of pending) {
      if (entry.clientSocket === socket) {
        clearTimeout(entry.timer);
        pending.delete(id);
      }
    }
  });

  socket.on("error", (err) => {
    log.error("IPC client error:", err.message);
  });
});

ipcServer.listen(ipcAddress, () => {
  log.info(`IPC server listening on ${ipcAddress}`);
});

ipcServer.on("error", (err) => {
  log.error(`IPC server error: ${err.message}`);
  process.exit(1);
});

// --- Utilities ---

function broadcastStatus() {
  const status = {
    type: "status",
    extensionConnected: !!(extensionSocket && extensionSocket.readyState === extensionSocket.OPEN),
    ...(extensionVersionWarning ? { extensionVersionWarning } : {}),
  };
  for (const [client] of clients) {
    sendNdjson(client, status);
  }
}

// --- Cleanup on exit ---

function cleanup() {
  log.info("Shutting down...");
  // Close IPC server and clean up socket file
  ipcServer.close();
  if (!ipcAddress.startsWith("\\\\.\\pipe\\")) {
    try { unlinkSync(ipcAddress); } catch { /* already gone */ }
  }
  // Close WebSocket and HTTP servers
  wss.close();
  httpServer.close();
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

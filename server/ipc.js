/**
 * Shared IPC utilities for browser-bridge daemon and client.
 *
 * Protocol: ndjson (newline-delimited JSON) over Unix socket or Windows named pipe.
 */

import { homedir, platform } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const PORT = parseInt(process.env.BROWSER_BRIDGE_PORT || "7225", 10);
const DAEMON_NAME = `claude-browser-bridge-${PORT}`;

/**
 * Get the IPC address for the daemon.
 * Uses DAEMON_IPC_ADDRESS env var if set, otherwise computes from platform.
 */
export function getIpcAddress() {
  if (process.env.DAEMON_IPC_ADDRESS) {
    return process.env.DAEMON_IPC_ADDRESS;
  }
  if (platform() === "win32") {
    return `\\\\.\\pipe\\claude-daemon-${DAEMON_NAME}`;
  }
  const dir = join(homedir(), ".claude", "daemons");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${DAEMON_NAME}.sock`);
}

export { DAEMON_NAME, PORT };

/**
 * Parse ndjson from a stream. Calls onMessage for each complete JSON object.
 * Handles partial reads and multiple messages in a single chunk.
 */
export function createNdjsonParser(onMessage) {
  let buffer = "";
  return (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onMessage(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
      }
    }
  };
}

/**
 * Send an ndjson message over a socket.
 */
export function sendNdjson(socket, obj) {
  socket.write(JSON.stringify(obj) + "\n");
}

/**
 * Shared IPC utilities for browser-bridge daemon and client.
 *
 * Protocol: ndjson (newline-delimited JSON) over Unix socket or Windows named pipe.
 */

import { homedir, platform } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const PORT = parseInt(process.env.BROWSER_BRIDGE_PORT || "7225", 10);
const DAEMON_NAME = "claude-browser-bridge";

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

/**
 * Path to the daemon's pidfile: ~/.claude/daemons/<DAEMON_NAME>.pid.
 *
 * Always anchored to the real daemons dir (not derived from DAEMON_IPC_ADDRESS)
 * so it matches exactly where the PreToolUse hook and daemon-manager look. The
 * daemon writes this on startup so the hook's liveness check passes regardless
 * of who launched it — lazy nohup, systemd, or launchd.
 */
export function getPidFilePath() {
  const dir = join(homedir(), ".claude", "daemons");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${DAEMON_NAME}.pid`);
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

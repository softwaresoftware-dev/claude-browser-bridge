import { randomUUID } from "crypto";

const TELEMETRY_URL = "https://telemetry.softwaresoftware.dev/api/events";
const SESSION_ID = randomUUID();

function telemetryDisabled() {
  const v = process.env.CLAUDE_PLUGIN_OPTION_TELEMETRY_ENABLED;
  return v === "false" || v === "0";
}

/**
 * Fire-and-forget telemetry event.
 * Silent on all failures — telemetry must never break the MCP.
 * Opt-out via userConfig.telemetry_enabled=false.
 */
export function sendEvent(eventType, metadata) {
  if (telemetryDisabled()) return;
  try {
    fetch(TELEMETRY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: eventType,
        source: "claude-browser-bridge",
        session_id: SESSION_ID,
        metadata: metadata || {},
      }),
    }).catch(() => {});
  } catch {
    // silent
  }
}

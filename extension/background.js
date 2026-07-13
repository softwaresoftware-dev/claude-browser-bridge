importScripts("observer.js");
importScripts("observer-a11y.js");
importScripts("dom-utils.js");

const WS_URL = "ws://127.0.0.1:7225";

// --- Connection state ---
let ws = null;
let reconnectDelay = 1000;
let connecting = false; // guard against double-connect
let heartbeatInterval = null;
const log = (...args) => console.log("[claude-browser-bridge]", ...args);
const logError = (...args) => console.error("[claude-browser-bridge]", ...args);

// Short session label for tab groups (first 8 chars of UUID)
const shortId = (id) => id && id.length > 8 ? id.slice(0, 8) : id;

// --- Session tab group isolation ---
const sessionGroups = new Map(); // sessionId → { groupId, color }
const GROUP_COLORS = ["blue", "red", "green", "yellow", "purple", "cyan", "pink"];
let groupColorIndex = 0;

// Persist session groups across service worker restarts
async function saveSessionGroups() {
  const data = {};
  for (const [sid, info] of sessionGroups) {
    data[sid] = info;
  }
  await chrome.storage.session.set({ sessionGroups: data, groupColorIndex });
}

async function loadSessionGroups() {
  try {
    const stored = await chrome.storage.session.get(["sessionGroups", "groupColorIndex"]);
    if (stored.sessionGroups) {
      for (const [sid, info] of Object.entries(stored.sessionGroups)) {
        // Verify the group still exists
        try {
          await chrome.tabGroups.get(info.groupId);
          sessionGroups.set(sid, info);
        } catch {
          // Group was removed — skip
        }
      }
    }
    if (stored.groupColorIndex !== undefined) groupColorIndex = stored.groupColorIndex;
  } catch {
    // storage.session not available or empty — start fresh
  }
}

async function ensureTabInGroup(tabId, sessionId) {
  if (!sessionId) return;

  let session = sessionGroups.get(sessionId);
  if (!session) {
    // First tab for this session — create the group
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    const color = GROUP_COLORS[groupColorIndex++ % GROUP_COLORS.length];
    await chrome.tabGroups.update(groupId, { title: `Claude ${shortId(sessionId)}`, color });
    session = { groupId, color };
    sessionGroups.set(sessionId, session);
    await saveSessionGroups();
    return;
  }

  // Check if tab is already in the group
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId === session.groupId) return;

  // Move tab into the group
  await chrome.tabs.group({ tabIds: [tabId], groupId: session.groupId });
}

async function handleSessionEnd(sessionId) {
  const session = sessionGroups.get(sessionId);
  if (!session) return;

  try {
    await chrome.tabGroups.update(session.groupId, {
      title: `Claude ${shortId(sessionId)} (ended)`,
      collapsed: true,
    });
  } catch {
    // Group already removed
  }

  sessionGroups.delete(sessionId);
  await saveSessionGroups();
}

// Clean up stale entries when user removes a tab group
chrome.tabGroups.onRemoved.addListener((group) => {
  for (const [sid, info] of sessionGroups) {
    if (info.groupId === group.id) {
      sessionGroups.delete(sid);
      saveSessionGroups();
      break;
    }
  }
});

// Restore state on service worker startup
loadSessionGroups();

// --- Badge: connection status indicator ---

function setBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#22c55e" : "#ef4444" });
}

// --- WebSocket connection with guards ---

function connect() {
  // Prevent double-connect: if already open or mid-handshake, skip
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  connecting = true;
  ws = null;

  let socket;
  try {
    socket = new WebSocket(WS_URL);
  } catch (err) {
    logError("Failed to create WebSocket:", err.message);
    connecting = false;
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    log("Connected to MCP server");
    ws = socket;
    connecting = false;
    reconnectDelay = 1000;
    setBadge(true);
    startHeartbeat();
  };

  socket.onclose = () => {
    log("Disconnected, reconnecting in", reconnectDelay, "ms");
    cleanup(socket);
    scheduleReconnect();
  };

  socket.onerror = (err) => {
    logError("WebSocket error:", err);
    // onclose will fire after onerror, so cleanup happens there
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      logError("Bad message:", event.data);
      return;
    }

    // Handle version check from daemon
    if (msg.type === "version_check") {
      const current = chrome.runtime.getManifest().version;
      const expected = msg.expectedVersion;
      const outdated = current !== expected;
      safeSend(socket, { type: "version_report", currentVersion: current, expectedVersion: expected, outdated });
      if (outdated) {
        log(`Extension v${current} is outdated — v${expected} available. Reload from extensions page.`);
        chrome.action.setBadgeText({ text: "UPD" });
        chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
      }
      return;
    }

    // Handle session lifecycle messages (no response expected)
    if (msg.type === "session_end") {
      await handleSessionEnd(msg.sessionId);
      return;
    }

    try {
      const data = await handleRequest(msg.action, msg.params || {}, msg.sessionId);
      safeSend(socket, { id: msg.id, success: true, data });
    } catch (err) {
      safeSend(socket, { id: msg.id, success: false, error: err.message });
    }
  };

  // If the handshake doesn't complete in 5s, abort and retry
  setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) {
      log("Connection handshake timed out, aborting");
      socket.close();
    }
  }, 5000);
}

function cleanup(socket) {
  if (ws === socket) ws = null;
  connecting = false;
  setBadge(false);
  stopHeartbeat();
}

function scheduleReconnect() {
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

// --- Safe send: handles socket closed between request start and response ---

function safeSend(socket, payload) {
  try {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return true;
    }
    logError("Cannot send, socket not open. Dropping response for id:", payload.id);
    return false;
  } catch (err) {
    logError("Send failed:", err.message, "Dropping response for id:", payload.id);
    return false;
  }
}

// --- Heartbeat: detect silently dead connections ---
// Server pings every 20s; we also send our own pings to detect dead connections faster.

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // WebSocket API in service workers doesn't expose ping(), so send a
      // lightweight application-level heartbeat. The server ignores unknown
      // messages (JSON.parse fails → logged and dropped), but the send itself
      // will throw / trigger onclose if the TCP connection is dead.
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        log("Heartbeat send failed, connection dead");
        ws.close();
      }
    }
  }, 15000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// --- Service worker keepalive ---
// Chrome can kill the service worker after 30s of inactivity.
// The alarm fires every 20s to keep it alive and check the connection.
// Additionally, we extend lifetime during active requests.

chrome.alarms.create("keepalive", { periodInMinutes: 1 / 3 }); // ~20s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
    }
  }
});

// Attempt graceful cleanup on service worker suspension
if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    log("Service worker suspending");
    stopHeartbeat();
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
  });
}

// Initial connection
connect();

// --- Tab ID resolution ---

async function resolveTabId(tabId, sessionId) {
  // Explicit tab_id always wins (cross-session escape hatch)
  if (tabId !== undefined && tabId !== null) {
    try {
      await chrome.tabs.get(tabId);
      return tabId;
    } catch {
      throw new Error(`Tab ${tabId} not found or has been closed`);
    }
  }

  // If session has a tab group, resolve within it
  if (sessionId && sessionGroups.has(sessionId)) {
    const { groupId } = sessionGroups.get(sessionId);
    const tabs = await chrome.tabs.query({ groupId });
    // Prefer the active tab if it's in this group
    const active = tabs.find((t) => t.active);
    if (active) return active.id;
    // Otherwise return the most recently accessed tab in the group
    if (tabs.length > 0) {
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      return tabs[0].id;
    }
    // Group exists but empty — fall through to create a new tab below
  }

  // No session group yet (or group is empty) — create a new tab and group it
  // so each session gets its own isolated tab instead of sharing the active tab
  if (sessionId) {
    const newTab = await chrome.tabs.create({ active: false });
    await ensureTabInGroup(newTab.id, sessionId);
    return newTab.id;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");
  return tab.id;
}

// --- Execute a function in a tab's content script context ---

async function execInTab(tabId, func, args = []) {
  // Sanitize args: undefined is not serializable for executeScript
  const safeArgs = args.map((a) => (a === undefined ? null : a));
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args: safeArgs,
    });
  } catch (err) {
    if (err.message.includes("Cannot access")) {
      throw new Error(`Cannot execute script on this page (chrome://, extensions, or restricted URL)`);
    }
    if (err.message.includes("No tab with id")) {
      throw new Error(`Tab ${tabId} was closed during operation`);
    }
    throw err;
  }
  if (!results || results.length === 0) throw new Error("Script execution returned no results");
  const frame = results[0];
  if (frame.error) {
    throw new Error(frame.error.message || String(frame.error));
  }
  return frame.result;
}


// --- CDP (Chrome DevTools Protocol) helpers for trusted input events ---

const debuggerAttached = new Set();
const debuggerLocks = new Map(); // per-tab mutex to prevent concurrent attach races

async function attachDebugger(tabId) {
  // Serialize attach operations per-tab to prevent "already attached" races
  const prev = debuggerLocks.get(tabId) || Promise.resolve();
  const current = prev.then(() => _attachDebuggerImpl(tabId)).catch(() => _attachDebuggerImpl(tabId));
  debuggerLocks.set(tabId, current.catch(() => {})); // swallow for next waiter
  return current;
}

async function _attachDebuggerImpl(tabId) {
  if (debuggerAttached.has(tabId)) {
    // Verify still actually attached by sending a benign command
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" });
      return;
    } catch {
      // Stale entry — debugger was detached without us knowing
      debuggerAttached.delete(tabId);
    }
  }

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    if (err.message.includes("Already attached")) {
      // Another context attached it — safe to proceed
      debuggerAttached.add(tabId);
      return;
    }
    throw new Error(`Failed to attach debugger to tab ${tabId}: ${err.message}`);
  }

  debuggerAttached.add(tabId);

  // Make backgrounded tabs report visibilityState === "visible" so pages
  // like LinkedIn that pause their own SPA when hidden keep running layout.
  // Without this, getBoundingClientRect on backgrounded tabs returns zeros
  // and clicks resolve to (0,0). Verified by experiment-backgrounded-tab.js.
  // Per-debugger-session, per-tab — parallel sessions don't conflict.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch (err) {
    // Non-fatal: layout will still work on foreground tabs.
    console.warn("[claude-browser-bridge] setFocusEmulationEnabled failed:", err && err.message);
  }

  // Auto-cleanup when tab closes
  const onRemoved = (removedId) => {
    if (removedId === tabId) {
      debuggerAttached.delete(tabId);
      debuggerLocks.delete(tabId);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }
  };
  chrome.tabs.onRemoved.addListener(onRemoved);
}

async function detachDebugger(tabId) {
  if (!debuggerAttached.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached — ignore
  }
  debuggerAttached.delete(tabId);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) debuggerAttached.delete(source.tabId);
});

async function cdpSend(tabId, method, params = {}) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (err) {
    // If debugger detached mid-operation, clean up and throw clearly
    if (err.message.includes("Detached") || err.message.includes("not attached")) {
      debuggerAttached.delete(tabId);
      throw new Error(`Debugger was detached from tab ${tabId} during ${method}`);
    }
    throw err;
  }
}

// Per-tab serialization for full input sequences. Without this, two
// concurrent cdpClick calls interleave their mousePressed/mouseReleased pairs
// and Chrome reads it as a drag instead of two clicks.
const inputLocks = new Map();
function withInputLock(tabId, fn) {
  const prev = inputLocks.get(tabId) || Promise.resolve();
  const current = prev.then(fn, fn);
  inputLocks.set(tabId, current.catch(() => {}));
  return current;
}

async function cdpClick(tabId, x, y) {
  await attachDebugger(tabId);
  return withInputLock(tabId, async () => {
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1,
    });
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1,
    });
  });
}

async function cdpType(tabId, text) {
  await attachDebugger(tabId);
  const normalized = text.replace(/\r\n/g, "\n");
  return withInputLock(tabId, async () => {
    // Input.insertText inserts a whole segment atomically into the focused
    // element (like a paste) — orders of magnitude faster than per-character
    // key events on long text, and still fires input events. Newlines can't
    // be inserted as text; each one becomes a real Enter press so textareas
    // and contenteditables get an actual line/paragraph break.
    const segments = normalized.split("\n");
    for (let i = 0; i < segments.length; i++) {
      if (segments[i]) {
        await cdpSend(tabId, "Input.insertText", { text: segments[i] });
      }
      if (i < segments.length - 1) {
        await cdpSend(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown", key: "Enter", code: "Enter",
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          text: "\r", unmodifiedText: "\r",
        });
        await cdpSend(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp", key: "Enter", code: "Enter",
          windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        });
      }
    }
  });
}

// Named keys for press_key / clear flows. [key, code, windowsVirtualKeyCode, text?]
const NAMED_KEYS = {
  Enter: ["Enter", "Enter", 13, "\r"],
  Tab: ["Tab", "Tab", 9],
  Escape: ["Escape", "Escape", 27],
  Backspace: ["Backspace", "Backspace", 8],
  Delete: ["Delete", "Delete", 46],
  ArrowUp: ["ArrowUp", "ArrowUp", 38],
  ArrowDown: ["ArrowDown", "ArrowDown", 40],
  ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
  ArrowRight: ["ArrowRight", "ArrowRight", 39],
  Home: ["Home", "Home", 36],
  End: ["End", "End", 35],
  PageUp: ["PageUp", "PageUp", 33],
  PageDown: ["PageDown", "PageDown", 34],
  Space: [" ", "Space", 32, " "],
};

// Modifier bitmask per CDP Input.dispatchKeyEvent: Alt=1, Ctrl=2, Meta=4, Shift=8
const MODIFIER_BITS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

// Editing shortcuts differ per OS: select-all is Cmd+A on macOS, Ctrl+A
// elsewhere. Resolved once at startup.
let primaryModifier = MODIFIER_BITS.Control;
chrome.runtime.getPlatformInfo((info) => {
  if (info.os === "mac") primaryModifier = MODIFIER_BITS.Meta;
});

async function cdpKeyPress(tabId, keyName, modifiers = 0) {
  await attachDebugger(tabId);
  let def = NAMED_KEYS[keyName];
  if (!def && keyName.length === 1) {
    const upper = keyName.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(upper) ? `Digit${upper}` : "";
    def = [keyName, code, upper.charCodeAt(0), keyName];
  }
  if (!def) throw new Error(`Unknown key: ${keyName}`);
  const [key, code, vk, text] = def;
  const down = {
    type: "keyDown", key, code, modifiers,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  };
  // Only include text when the press should produce a character — a key held
  // under Ctrl/Alt/Meta is a shortcut, not input.
  if (text && !(modifiers & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta))) {
    down.text = text;
    down.unmodifiedText = text;
  }
  return withInputLock(tabId, async () => {
    await cdpSend(tabId, "Input.dispatchKeyEvent", down);
    await cdpSend(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", key, code, modifiers,
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
  });
}

// --- Accessibility-tree addressing ---
// Resolve an element by ARIA role + accessible name via the CDP Accessibility
// domain. The a11y tree is built from the *rendered* page, so it spans open
// shadow roots and same-process iframes, and survives DOM churn — pages keep
// roles and names stable because screen readers depend on them. This is the
// most robust addressing scheme for hostile SPAs (LinkedIn's composer).
async function axFind(tabId, role, name) {
  await attachDebugger(tabId);
  await cdpSend(tabId, "DOM.enable");
  await cdpSend(tabId, "Accessibility.enable");

  // Each frame has its own AX tree — a query rooted at the main document does
  // not descend into iframe documents. Walk the frame tree and match in each,
  // main frame first.
  const frameIds = [];
  (function collect(node) {
    frameIds.push(node.frame.id);
    for (const child of node.childFrames || []) collect(child);
  })((await cdpSend(tabId, "Page.getFrameTree")).frameTree);

  const needle = name ? name.toLowerCase() : null;
  const matches = (n) => {
    if (n.ignored || !n.backendDOMNodeId) return false;
    if (role && !(n.role && n.role.value === role)) return false;
    if (needle) {
      const nm = n.name && n.name.value;
      if (typeof nm !== "string") return false;
      if (nm !== name && !nm.toLowerCase().includes(needle)) return false;
    }
    return true;
  };

  for (const frameId of frameIds) {
    let nodes;
    try {
      ({ nodes } = await cdpSend(tabId, "Accessibility.getFullAXTree", { frameId }));
    } catch {
      continue; // frame gone or not accessible — keep looking
    }
    // Prefer an exact accessible-name match over a substring match.
    let hit = name
      ? (nodes || []).find((n) => matches(n) && n.name && n.name.value === name)
      : null;
    if (!hit) hit = (nodes || []).find(matches);
    if (hit) return hit.backendDOMNodeId;
  }
  throw new Error(`Element not found by role/name: role=${role || "*"} name=${name ? JSON.stringify(name) : "*"}`);
}

async function axCenter(tabId, backendNodeId) {
  try {
    await cdpSend(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // Non-scrollable or already visible — box model below still works.
  }
  const { model } = await cdpSend(tabId, "DOM.getBoxModel", { backendNodeId });
  const q = model.content; // quad: [x1,y1, x2,y2, x3,y3, x4,y4]
  return { x: Math.round((q[0] + q[4]) / 2), y: Math.round((q[1] + q[5]) / 2) };
}

function axLabel(params) {
  return `role=${params.role || "*"} name=${params.name || "*"}`;
}

async function cdpPress(tabId, key, code, keyCode) {
  await attachDebugger(tabId);
  return withInputLock(tabId, async () => {
    await cdpSend(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
    await cdpSend(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
  });
}

// Run a function in every frame of the tab. Returns the raw per-frame
// results (each with frameId). Frames the extension can't inject into are
// simply absent from the results.
async function execInTabFrames(tabId, func, args = []) {
  const safeArgs = args.map((a) => (a === undefined ? null : a));
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func,
      args: safeArgs,
    });
  } catch (err) {
    if (err.message.includes("Cannot access")) {
      throw new Error(`Cannot execute script on this page (chrome://, extensions, or restricted URL)`);
    }
    if (err.message.includes("No tab with id")) {
      throw new Error(`Tab ${tabId} was closed during operation`);
    }
    throw err;
  }
  return results || [];
}

// Find which frame contains the element. Pages render UI in same-origin
// iframes (LinkedIn's post composer lives in its /preload/ interop iframe),
// so lookup must sweep every frame — main frame wins ties.
async function locateFrame(tabId, selector) {
  const results = await execInTabFrames(tabId, browserBridgeElementOp, [{ op: "exists", selector }]);
  let invalid = null;
  const hits = [];
  for (const r of results) {
    const v = r && r.result;
    if (!v) continue;
    if (v.__err) {
      if (v.__err.startsWith("Invalid selector")) invalid = v.__err;
      continue;
    }
    if (v.found) hits.push(r.frameId);
  }
  if (invalid) throw new Error(invalid);
  if (hits.length === 0) throw new Error(`Element not found: ${selector}`);
  return hits.includes(0) ? 0 : hits.sort((a, b) => a - b)[0];
}

// Two-phase element op: locate the frame that has the element, then run the
// op only in that frame (avoids side effects like focus firing in frames
// where the selector matches something else).
async function runElementOp(tabId, opts) {
  const frameId = await locateFrame(tabId, opts.selector);
  const safeArgs = [opts].map((a) => (a === undefined ? null : a));
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: browserBridgeElementOp,
    args: safeArgs,
  });
  const v = results && results[0] && results[0].result;
  if (v && v.__err) throw new Error(v.__err);
  if (!v) throw new Error("Script execution returned no results");
  return v;
}

// Get element center coordinates for CDP click (root-viewport coordinates,
// translated through same-origin iframes by the "center" op).
async function getElementCenter(tabId, selector) {
  return runElementOp(tabId, { op: "center", selector });
}

// Last observe snapshot per tab: bbId → bbox. Some pages (LinkedIn's post
// composer) continuously replace the DOM nodes of a surface, so an id
// stamped by observe is gone by the next call and no selector — however
// deep — resolves it. The bbox from the snapshot still points at the right
// pixels, so click/type fall back to raw CDP input at those coordinates.
// Stored in chrome.storage.session so it survives service worker restarts.
async function saveObserveSnapshot(tabId, elements) {
  const snap = {};
  for (const el of elements) {
    if (el.id && el.bbox) snap[el.id] = el.bbox;
  }
  try {
    await chrome.storage.session.set({ [`bbSnap:${tabId}`]: snap });
  } catch {
    // storage.session unavailable — fallback simply won't have data
  }
}

async function snapshotBboxCenter(tabId, bbId) {
  try {
    const key = `bbSnap:${tabId}`;
    const data = await chrome.storage.session.get(key);
    const bbox = data[key] && data[key][bbId];
    if (!bbox) return null;
    return { x: Math.round(bbox[0] + bbox[2] / 2), y: Math.round(bbox[1] + bbox[3] / 2) };
  } catch {
    return null;
  }
}

// Accept either a bb-id (from observe) or a raw CSS selector, returning the
// selector to use. Bb-ids match /^\d+-\d+$/; nothing in that shape is a valid
// CSS selector by itself, so refusing mixed inputs is safe.
function resolveTargetSelector(params) {
  if (params.id) {
    if (!/^\d+-\d+$/.test(params.id)) {
      throw new Error(`Invalid id format: ${params.id} (expected "<frame>-<index>")`);
    }
    return `[data-bb-id="${params.id}"]`;
  }
  if (params.selector) return params.selector;
  throw new Error("Missing required parameter: id or selector");
}

// --- Request handlers ---

async function handleRequest(action, params, sessionId) {
  switch (action) {
    case "list_tabs": {
      let query = {};
      if (!params.all_tabs && sessionId && sessionGroups.has(sessionId)) {
        query.groupId = sessionGroups.get(sessionId).groupId;
      }
      const tabs = await chrome.tabs.query(query);
      return tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        groupId: t.groupId,
      }));
    }

    case "get_tab_info": {
      const tabId = await resolveTabId(params.tab_id, sessionId);
      const tab = await chrome.tabs.get(tabId);
      return { id: tab.id, url: tab.url, title: tab.title, status: tab.status };
    }

    case "screenshot": {
      const tabId = await resolveTabId(params.tab_id, sessionId);

      // Use CDP Page.captureScreenshot to avoid stealing focus
      try {
        await attachDebugger(tabId);
        const result = await cdpSend(tabId, "Page.captureScreenshot", { format: "png" });
        return result.data; // already base64
      } catch (err) {
        if (err.message.includes("Cannot access") || err.message.includes("Cannot attach")) {
          throw new Error("Cannot capture this page (chrome://, devtools, or browser UI)");
        }
        throw err;
      }
    }

    case "get_page_content": {
      const tabId = await resolveTabId(params.tab_id, sessionId);
      const format = params.format || "text";

      return await execInTab(tabId, (fmt) => {
        if (fmt === "html") return document.documentElement.outerHTML;
        return document.body.innerText;
      }, [format]);
    }

    case "navigate": {
      const tabId = await resolveTabId(params.tab_id, sessionId);

      if (!params.url) throw new Error("Missing required parameter: url");

      // Ensure this tab belongs to the session's tab group
      await ensureTabInGroup(tabId, sessionId);

      await chrome.tabs.update(tabId, { url: params.url });

      // Wait for page load with timeout
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error(`Navigation timed out after 55s for URL: ${params.url}`));
        }, 55000);

        function listener(updatedTabId, changeInfo) {
          if (updatedTabId === tabId && changeInfo.status === "complete") {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            chrome.tabs.get(tabId).then(
              (tab) => resolve({ url: tab.url, title: tab.title }),
              (err) => reject(new Error(`Tab closed during navigation: ${err.message}`))
            );
          }
        }

        chrome.tabs.onUpdated.addListener(listener);
      });
    }

    case "click": {
      const tabId0 = await resolveTabId(params.tab_id, sessionId);
      if (params.role || params.name) {
        const backendNodeId = await axFind(tabId0, params.role, params.name);
        const { x, y } = await axCenter(tabId0, backendNodeId);
        await cdpClick(tabId0, x, y);
        return { clicked: axLabel(params), x, y, method: "a11y" };
      }
      const selector = resolveTargetSelector(params);
      const tabId = tabId0;
      // Attach before bbox query so backgrounded tabs (LinkedIn etc.) report
      // real coordinates instead of zeros.
      await attachDebugger(tabId);
      let x, y, method = "cdp";
      try {
        ({ x, y } = await getElementCenter(tabId, selector));
      } catch (err) {
        const center = params.id ? await snapshotBboxCenter(tabId, params.id) : null;
        if (!center) throw err;
        ({ x, y } = center);
        method = "cdp-bbox";
      }
      await cdpClick(tabId, x, y);
      return { clicked: selector, x, y, method };
    }

    case "type": {
      if (params.text === undefined || params.text === null) throw new Error("Missing required parameter: text");

      if (params.role || params.name) {
        const tabIdA = await resolveTabId(params.tab_id, sessionId);
        const backendNodeId = await axFind(tabIdA, params.role, params.name);
        try {
          await cdpSend(tabIdA, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
        } catch {}
        await cdpSend(tabIdA, "DOM.focus", { backendNodeId });
        if (params.clear !== false) {
          await cdpKeyPress(tabIdA, "a", primaryModifier);
          await cdpKeyPress(tabIdA, "Backspace");
        }
        await cdpType(tabIdA, params.text);
        return { typed: params.text, target: axLabel(params), method: "a11y" };
      }

      const selector = resolveTargetSelector(params);
      const tabId = await resolveTabId(params.tab_id, sessionId);
      await attachDebugger(tabId);
      let method = "cdp";
      try {
        await runElementOp(tabId, { op: "focus", selector, clear: params.clear !== false });
      } catch (err) {
        // Selector lookup failed — focus the element by clicking the center
        // of its bbox from the last observe snapshot (no clear support here;
        // there is no element handle to clear).
        const center = params.id ? await snapshotBboxCenter(tabId, params.id) : null;
        if (!center) {
          let dbg = "";
          if (params.id) {
            try {
              const all = await chrome.storage.session.get(null);
              dbg = ` (bbox fallback unavailable: keys=${Object.keys(all).join(",") || "none"})`;
            } catch (e2) {
              dbg = ` (bbox fallback unavailable: storage.session: ${e2.message})`;
            }
          }
          throw new Error(err.message + dbg);
        }
        await cdpClick(tabId, center.x, center.y);
        await new Promise((resolve) => setTimeout(resolve, 150));
        method = "cdp-bbox";
      }
      await cdpType(tabId, params.text);
      return { typed: params.text, selector, method };
    }

    case "observe": {
      const tabId = await resolveTabId(params.tab_id, sessionId);
      await attachDebugger(tabId);
      const opts = {
        viewportOnly: !!params.viewport_only,
      };
      // Observe every frame — pages like LinkedIn render whole surfaces (the
      // post composer) in same-origin iframes. Each frame reports its own
      // elements with root-viewport bboxes; hidden/cross-origin frames
      // return null and are dropped.
      const frameResults = await execInTabFrames(tabId, browserBridgeObserve, [opts]);
      const frames = frameResults.map((r) => r && r.result).filter(Boolean);
      const main = frames.find((f) => f.frameIndex === 0) || frames[0];
      if (!main) throw new Error("observe returned no results");
      const result = { ...main, elements: frames.flatMap((f) => f.elements) };

      // Remember bboxes so click/type can fall back to coordinates when a
      // page discards the stamped ids (see saveObserveSnapshot).
      await saveObserveSnapshot(tabId, result.elements);

      if (params.include_screenshot !== false) {
        try {
          await attachDebugger(tabId);
          const shot = await cdpSend(tabId, "Page.captureScreenshot", { format: "png" });
          result.screenshot = shot.data;
        } catch (err) {
          result.screenshot_error = err.message;
        }
      }
      return result;
    }

    case "observe_a11y": {
      const tabId = await resolveTabId(params.tab_id, sessionId);
      await attachDebugger(tabId);
      const opts = {
        frameIndex: 0,
        viewportOnly: !!params.viewport_only,
        maxDepth: params.max_depth || 60,
      };
      return await execInTab(tabId, browserBridgeObserveA11y, [opts]);
    }

    case "eval_js": {
      const code = params.code || params.expression;
      if (!code) throw new Error("Missing required parameter: code (or expression)");
      const tabId = await resolveTabId(params.tab_id, sessionId);
      // Runtime.evaluate through the debugger is exempt from the page's CSP —
      // unlike MAIN-world eval() injection, which sites like LinkedIn block
      // with script-src that lacks unsafe-eval.
      await attachDebugger(tabId);
      const res = await cdpSend(tabId, "Runtime.evaluate", {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        const raw = (d.exception && (d.exception.description || d.exception.value)) || d.text || "evaluation failed";
        throw new Error(`eval_js: ${String(raw).split("\n")[0]}`);
      }
      // Undefined isn't serializable across the wire — preserve the historic
      // null semantic.
      return res.result && "value" in res.result ? res.result.value : null;
    }

    case "press_key": {
      if (!params.key) throw new Error("Missing required parameter: key");
      const tabId = await resolveTabId(params.tab_id, sessionId);
      let modifiers = 0;
      for (const mod of params.modifiers || []) {
        const bit = MODIFIER_BITS[mod];
        if (!bit) throw new Error(`Unknown modifier: ${mod}`);
        modifiers |= bit;
      }
      await cdpKeyPress(tabId, params.key, modifiers);
      return { pressed: params.key, modifiers: params.modifiers || [] };
    }

    case "reload_extension": {
      // Reply first, then reload — the response has to leave before the
      // service worker dies. Reload picks up edited extension code from disk,
      // which a browser restart alone does not reliably do (stale script cache).
      setTimeout(() => chrome.runtime.reload(), 300);
      return { reloading: true, version: chrome.runtime.getManifest().version };
    }

    case "fill_form": {
      if (!params.fields || !Array.isArray(params.fields)) {
        throw new Error("Missing required parameter: fields (array of {selector, value})");
      }
      const tabId = await resolveTabId(params.tab_id, sessionId);
      await attachDebugger(tabId);
      const results = [];
      for (const { selector: fieldSel, value } of params.fields) {
        try {
          await runElementOp(tabId, { op: "fill_one", selector: fieldSel, value });
          results.push({ selector: fieldSel, success: true });
        } catch (err) {
          results.push({ selector: fieldSel, success: false, error: err.message });
        }
      }
      return { filled: results.filter((r) => r.success).length, total: params.fields.length, results };
    }

    case "get_element_info": {
      if (!params.selector) throw new Error("Missing required parameter: selector");
      const tabId = await resolveTabId(params.tab_id, sessionId);
      await attachDebugger(tabId);
      return await runElementOp(tabId, { op: "info", selector: params.selector });
    }

    case "wait_for": {
      if (!params.selector && !params.role && !params.name) {
        throw new Error("Missing required parameter: selector (or role/name)");
      }
      const tabId = await resolveTabId(params.tab_id, sessionId);
      await attachDebugger(tabId);
      const timeout = params.timeout || 10000;

      if (params.role || params.name) {
        const axDeadline = Date.now() + timeout;
        for (;;) {
          try {
            await axFind(tabId, params.role, params.name);
            return { found: true, target: axLabel(params) };
          } catch {
            // Not there yet — keep polling.
          }
          if (Date.now() >= axDeadline) throw new Error(`Timed out waiting for: ${axLabel(params)}`);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }

      // Poll across all frames — a MutationObserver can't see into iframes
      // or shadow roots, so a sweep every 250ms is the reliable option.
      const deadline = Date.now() + timeout;
      for (;;) {
        try {
          await locateFrame(tabId, params.selector);
          return { found: true, selector: params.selector };
        } catch (err) {
          if (err.message.startsWith("Invalid selector")) throw err;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${params.selector}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    case "scroll": {
      const tabId = await resolveTabId(params.tab_id, sessionId);
      await attachDebugger(tabId);
      const scrollOpts = { op: "scroll", selector: params.selector, x: params.x || 0, y: params.y || 0, behavior: params.behavior || "instant" };
      if (params.selector) {
        return await runElementOp(tabId, scrollOpts);
      }
      // Window scroll targets the main frame only — running it in all frames
      // would scroll every iframe on the page.
      const scrollResult = await execInTab(tabId, browserBridgeElementOp, [scrollOpts]);
      if (scrollResult && scrollResult.__err) throw new Error(scrollResult.__err);
      return scrollResult;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

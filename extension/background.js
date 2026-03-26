const WS_URL = "ws://localhost:7225";
let ws = null;
let reconnectDelay = 1000;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[browser-bridge] Connected to MCP server");
    reconnectDelay = 1000;
  };

  ws.onclose = () => {
    console.log("[browser-bridge] Disconnected, reconnecting in", reconnectDelay, "ms");
    ws = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  ws.onerror = (err) => {
    console.error("[browser-bridge] WebSocket error:", err);
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.error("[browser-bridge] Bad message:", event.data);
      return;
    }

    try {
      const data = await handleRequest(msg.action, msg.params || {});
      ws.send(JSON.stringify({ id: msg.id, success: true, data }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, success: false, error: err.message }));
    }
  };
}

// keepalive alarm to prevent service worker death
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
    }
  }
});

connect();

// --- Tab ID resolution ---

async function resolveTabId(tabId) {
  if (tabId !== undefined && tabId !== null) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found");
  return tab.id;
}

// --- Execute a function in a tab's content script context ---

async function execInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  if (!results || results.length === 0) throw new Error("Script execution returned no results");
  if (results[0].error) throw new Error(results[0].error.message);
  return results[0].result;
}

async function execInTabMainWorld(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
    world: "MAIN",
  });
  if (!results || results.length === 0) throw new Error("Script execution returned no results");
  if (results[0].error) throw new Error(results[0].error.message);
  return results[0].result;
}

// --- Request handlers ---

async function handleRequest(action, params) {
  switch (action) {
    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
      }));
    }

    case "get_tab_info": {
      const tabId = await resolveTabId(params.tab_id);
      const tab = await chrome.tabs.get(tabId);
      return { id: tab.id, url: tab.url, title: tab.title, status: tab.status };
    }

    case "screenshot": {
      const tabId = await resolveTabId(params.tab_id);
      const tab = await chrome.tabs.get(tabId);

      // focus the tab's window and activate the tab
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });

      // brief delay for rendering
      await new Promise((r) => setTimeout(r, 250));

      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      // strip data:image/png;base64, prefix
      return dataUrl.replace(/^data:image\/png;base64,/, "");
    }

    case "get_page_content": {
      const tabId = await resolveTabId(params.tab_id);
      const format = params.format || "text";

      return await execInTab(tabId, (fmt) => {
        if (fmt === "html") return document.documentElement.outerHTML;
        return document.body.innerText;
      }, [format]);
    }

    case "navigate": {
      const tabId = await resolveTabId(params.tab_id);
      await chrome.tabs.update(tabId, { url: params.url });

      // wait for page load
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error("Navigation timed out"));
        }, 55000);

        function listener(updatedTabId, changeInfo) {
          if (updatedTabId === tabId && changeInfo.status === "complete") {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            chrome.tabs.get(tabId).then((tab) => {
              resolve({ url: tab.url, title: tab.title });
            });
          }
        }

        chrome.tabs.onUpdated.addListener(listener);
      });
    }

    case "click": {
      const tabId = await resolveTabId(params.tab_id);
      return await execInTab(tabId, (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Element not found: ${selector}`);
        el.scrollIntoView({ block: "center" });
        el.click();
        return { clicked: selector, tagName: el.tagName.toLowerCase() };
      }, [params.selector]);
    }

    case "type": {
      const tabId = await resolveTabId(params.tab_id);
      return await execInTab(tabId, (selector, text, clear) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Element not found: ${selector}`);
        el.focus();
        if (clear) el.value = "";
        // type character by character for better compatibility
        for (const char of text) {
          el.value += char;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: char, inputType: "insertText" }));
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { typed: text, selector };
      }, [params.selector, params.text, params.clear !== false]);
    }

    case "eval_js": {
      const tabId = await resolveTabId(params.tab_id);
      return await execInTabMainWorld(tabId, (code) => {
        // eslint-disable-next-line no-eval
        return eval(code);
      }, [params.code]);
    }

    case "fill_form": {
      const tabId = await resolveTabId(params.tab_id);
      return await execInTab(tabId, (fields) => {
        const results = [];
        for (const { selector, value } of fields) {
          const el = document.querySelector(selector);
          if (!el) {
            results.push({ selector, success: false, error: "Element not found" });
            continue;
          }
          el.focus();
          el.value = value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          results.push({ selector, success: true });
        }
        return { filled: results.filter((r) => r.success).length, total: fields.length, results };
      }, [params.fields]);
    }

    case "get_element_info": {
      const tabId = await resolveTabId(params.tab_id);
      return await execInTab(tabId, (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Element not found: ${selector}`);
        const rect = el.getBoundingClientRect();
        const attrs = {};
        for (const attr of el.attributes) attrs[attr.name] = attr.value;
        return {
          tagName: el.tagName.toLowerCase(),
          id: el.id,
          className: el.className,
          text: el.innerText?.substring(0, 500),
          attributes: attrs,
          boundingRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          isVisible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden",
        };
      }, [params.selector]);
    }

    case "wait_for": {
      const tabId = await resolveTabId(params.tab_id);
      const timeout = params.timeout || 10000;

      return await execInTab(tabId, (selector, timeoutMs) => {
        return new Promise((resolve, reject) => {
          // check if already present
          if (document.querySelector(selector)) {
            resolve({ found: true, selector });
            return;
          }

          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Timed out waiting for: ${selector}`));
          }, timeoutMs);

          const observer = new MutationObserver(() => {
            if (document.querySelector(selector)) {
              clearTimeout(timer);
              observer.disconnect();
              resolve({ found: true, selector });
            }
          });

          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        });
      }, [params.selector, timeout]);
    }

    case "scroll": {
      const tabId = await resolveTabId(params.tab_id);
      return await execInTab(tabId, (x, y, selector, behavior) => {
        const opts = { left: x, top: y, behavior };
        if (selector) {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`Element not found: ${selector}`);
          el.scrollBy(opts);
        } else {
          window.scrollBy(opts);
        }
        return { scrolled: { x, y }, selector: selector || "window" };
      }, [params.x || 0, params.y || 0, params.selector, params.behavior || "instant"]);
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

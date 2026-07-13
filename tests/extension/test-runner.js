const puppeteer = require("puppeteer-core");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const { copyExtension, artifactDir } = require("./test-helpers");

const PORT = 7226;
const EXTENSION_PATH = artifactDir("runner1-ext");
const PROFILE_DIR = artifactDir("runner1-profile");
const TEST_PAGE = `file://${path.resolve(__dirname, "test-page.html")}`;

// Colors
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

let msgId = 0;
let ws = null;
const results = [];

function send(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) {
      reject(new Error("No connected client"));
      return;
    }
    const id = ++msgId;
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for response to ${action}`)), 30000);
    const handler = (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.off("message", handler);
        msg.success ? resolve(msg.data) : reject(new Error(msg.error || "Unknown error"));
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id, action, params }));
  });
}

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    console.log(green("PASS"));
    results.push({ name, pass: true });
  } catch (err) {
    console.log(red(`FAIL: ${err.message}`));
    results.push({ name, pass: false, error: err.message });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "Assertion failed"); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

async function waitForConnection(wss, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Extension did not connect within timeout")), timeoutMs);
    wss.on("connection", (socket) => {
      clearTimeout(timeout);
      ws = socket;
      socket.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "ping") return;
        } catch {}
      });
      resolve();
    });
  });
}

async function runTests() {
  console.log(cyan("\n=== Browser Bridge Extension Test Suite ===\n"));

  // ---- list_tabs ----
  console.log(yellow("--- list_tabs ---"));
  let tabs;
  await test("list_tabs returns array", async () => {
    tabs = await send("list_tabs");
    assert(Array.isArray(tabs), "Expected array");
    assert(tabs.length > 0, "Expected at least one tab");
  });

  await test("tab objects have expected fields", async () => {
    const tab = tabs[0];
    assert(tab.id !== undefined, "Missing id");
    assert(tab.url !== undefined, "Missing url");
    assert(tab.title !== undefined, "Missing title");
    assert(typeof tab.active === "boolean", "active should be boolean");
  });

  // ---- navigate ----
  console.log(yellow("\n--- navigate ---"));
  let tabId;
  await test("navigate to test page", async () => {
    tabId = tabs[0].id;
    const result = await send("navigate", { tab_id: tabId, url: TEST_PAGE });
    assert(result.url.includes("test-page.html"), `URL should contain test-page.html, got ${result.url}`);
    assertEqual(result.title, "Browser Bridge Test Page");
  });

  await test("navigate without url throws error", async () => {
    try {
      await send("navigate", { tab_id: tabId });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("Missing required parameter"), `Expected missing param error, got: ${err.message}`);
    }
  });

  // ---- get_tab_info ----
  console.log(yellow("\n--- get_tab_info ---"));
  await test("get_tab_info returns correct data", async () => {
    const info = await send("get_tab_info", { tab_id: tabId });
    assertEqual(info.id, tabId);
    assert(info.url.includes("test-page.html"), "URL mismatch");
    assertEqual(info.title, "Browser Bridge Test Page");
    assertEqual(info.status, "complete");
  });

  await test("get_tab_info with invalid tab_id throws", async () => {
    try {
      await send("get_tab_info", { tab_id: 999999 });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("not found") || err.message.includes("closed"), `Unexpected: ${err.message}`);
    }
  });

  await test("get_tab_info without tab_id uses active tab", async () => {
    const info = await send("get_tab_info", {});
    assert(info.id !== undefined, "Should resolve to active tab");
  });

  // ---- get_page_content ----
  console.log(yellow("\n--- get_page_content ---"));
  await test("get_page_content returns text by default", async () => {
    const content = await send("get_page_content", { tab_id: tabId });
    assert(typeof content === "string", "Expected string");
    assert(content.includes("Browser Bridge Test Page"), "Should contain page title");
    assert(content.includes("Click Me"), "Should contain button text");
  });

  await test("get_page_content with format=html returns HTML", async () => {
    const html = await send("get_page_content", { tab_id: tabId, format: "html" });
    assert(html.includes("<html"), "Should contain HTML tags");
    assert(html.includes('id="title"'), "Should contain element IDs");
  });

  // ---- get_element_info ----
  console.log(yellow("\n--- get_element_info ---"));
  await test("get_element_info for visible element", async () => {
    const info = await send("get_element_info", { tab_id: tabId, selector: "#title" });
    assertEqual(info.tagName, "h1");
    assertEqual(info.id, "title");
    assert(info.text.includes("Browser Bridge Test Page"), "Text mismatch");
    assert(info.isVisible, "Should be visible");
    assert(info.boundingRect.width > 0, "Width > 0");
  });

  await test("get_element_info for hidden element", async () => {
    const info = await send("get_element_info", { tab_id: tabId, selector: "#hidden-el" });
    assertEqual(info.id, "hidden-el");
    assertEqual(info.boundingRect.width, 0);
    assert(!info.isVisible, "Should not be visible");
  });

  await test("get_element_info for nonexistent throws", async () => {
    try {
      await send("get_element_info", { tab_id: tabId, selector: "#nope" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("not found"), `Unexpected: ${err.message}`);
    }
  });

  await test("get_element_info without selector throws", async () => {
    try {
      await send("get_element_info", { tab_id: tabId });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("Missing required parameter"), `Unexpected: ${err.message}`);
    }
  });

  // ---- click (CDP) ----
  console.log(yellow("\n--- click (CDP) ---"));
  await test("click button via CDP", async () => {
    const result = await send("click", { tab_id: tabId, selector: "#click-btn" });
    assertEqual(result.method, "cdp");
    assert(result.x > 0 && result.y > 0, "Coords should be positive");
    await new Promise((r) => setTimeout(r, 300));
    const info = await send("get_element_info", { tab_id: tabId, selector: "#click-btn" });
    assertEqual(info.text, "Clicked!");
  });

  await test("click counter button multiple times", async () => {
    await send("click", { tab_id: tabId, selector: "#counter-btn" });
    await new Promise((r) => setTimeout(r, 150));
    await send("click", { tab_id: tabId, selector: "#counter-btn" });
    await new Promise((r) => setTimeout(r, 150));
    await send("click", { tab_id: tabId, selector: "#counter-btn" });
    await new Promise((r) => setTimeout(r, 150));
    const info = await send("get_element_info", { tab_id: tabId, selector: "#counter-btn" });
    assertEqual(info.text, "Count: 3");
  });

  await test("click nonexistent element throws", async () => {
    try {
      await send("click", { tab_id: tabId, selector: "#nope" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("not found"), `Unexpected: ${err.message}`);
    }
  });

  await test("click zero-size element throws", async () => {
    try {
      await send("click", { tab_id: tabId, selector: "#zero-size" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("zero size"), `Unexpected: ${err.message}`);
    }
  });

  await test("click without selector throws", async () => {
    try {
      await send("click", { tab_id: tabId });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("Missing required parameter"), `Unexpected: ${err.message}`);
    }
  });

  // ---- type (CDP) ----
  console.log(yellow("\n--- type (CDP) ---"));
  await test("type text into input", async () => {
    const result = await send("type", { tab_id: tabId, selector: "#name-input", text: "Claude" });
    assertEqual(result.method, "cdp");
    const val = await send("eval_js", { tab_id: tabId, code: `document.getElementById('name-input').value` });
    assertEqual(val, "Claude");
  });

  await test("type clears input by default", async () => {
    await send("type", { tab_id: tabId, selector: "#name-input", text: "New" });
    const val = await send("eval_js", { tab_id: tabId, code: `document.getElementById('name-input').value` });
    assertEqual(val, "New");
  });

  await test("type with clear=false appends", async () => {
    await send("type", { tab_id: tabId, selector: "#name-input", text: "First", clear: true });
    await send("type", { tab_id: tabId, selector: "#name-input", text: "Second", clear: false });
    const val = await send("eval_js", { tab_id: tabId, code: `document.getElementById('name-input').value` });
    assertEqual(val, "FirstSecond");
  });

  await test("type into nonexistent element throws", async () => {
    try {
      await send("type", { tab_id: tabId, selector: "#nope", text: "test" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("not found"), `Unexpected: ${err.message}`);
    }
  });

  await test("type without text throws", async () => {
    try {
      await send("type", { tab_id: tabId, selector: "#name-input" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("Missing required parameter"), `Unexpected: ${err.message}`);
    }
  });

  await test("type preserves newlines in textarea", async () => {
    await send("type", { tab_id: tabId, selector: "#multiline-input", text: "line one\nline two\n\nline four" });
    const val = await send("eval_js", { tab_id: tabId, code: `document.getElementById('multiline-input').value` });
    assertEqual(val, "line one\nline two\n\nline four");
  });

  // ---- shadow DOM ----
  console.log(yellow("\n--- shadow DOM ---"));
  const shadowEval = (inner) => `document.getElementById('shadow-host').shadowRoot.querySelector(${JSON.stringify(inner)})`;

  await test("observe lists elements inside shadow root", async () => {
    const result = await send("observe", { tab_id: tabId, include_screenshot: false });
    const input = result.elements.find((e) => e.name === "shadow input");
    assert(input, "observe should list the shadow input");
  });

  await test("type into input inside shadow root", async () => {
    await send("type", { tab_id: tabId, selector: "#shadow-input", text: "pierced" });
    const val = await send("eval_js", { tab_id: tabId, code: `${shadowEval("#shadow-input")}.value` });
    assertEqual(val, "pierced");
  });

  await test("click button inside shadow root via bb-id", async () => {
    const obs = await send("observe", { tab_id: tabId, include_screenshot: false });
    const btn = obs.elements.find((e) => e.name === "Shadow Click");
    assert(btn, "observe should list the shadow button");
    await send("click", { tab_id: tabId, id: btn.id });
    const text = await send("eval_js", { tab_id: tabId, code: `${shadowEval("#shadow-btn")}.textContent` });
    assertEqual(text, "Shadow Clicked!");
  });

  await test("type newlines into contenteditable inside shadow root", async () => {
    await send("type", { tab_id: tabId, selector: "#shadow-editor", text: "para one\npara two" });
    const text = await send("eval_js", { tab_id: tabId, code: `${shadowEval("#shadow-editor")}.innerText` });
    assert(text.includes("para one") && text.includes("para two"), `innerText: ${JSON.stringify(text)}`);
    assert(text.includes("\n"), `expected a line break between paragraphs, got: ${JSON.stringify(text)}`);
  });

  await test("type clear=true replaces contenteditable content", async () => {
    await send("type", { tab_id: tabId, selector: "#shadow-editor", text: "fresh", clear: true });
    const text = await send("eval_js", { tab_id: tabId, code: `${shadowEval("#shadow-editor")}.innerText` });
    assertEqual(text.trim(), "fresh");
  });

  await test("get_element_info pierces shadow root", async () => {
    const info = await send("get_element_info", { tab_id: tabId, selector: "#shadow-input" });
    assertEqual(info.tagName, "input");
  });

  await test("wait_for resolves for element inside shadow root", async () => {
    const result = await send("wait_for", { tab_id: tabId, selector: "#shadow-editor", timeout: 3000 });
    assert(result.found, "should find shadow element");
  });

  // ---- iframes ----
  console.log(yellow("\n--- iframes ---"));
  const frameEval = (inner) => `document.getElementById('test-iframe').contentDocument.querySelector(${JSON.stringify(inner)})`;

  await test("observe lists elements inside same-origin iframe", async () => {
    const obs = await send("observe", { tab_id: tabId, include_screenshot: false });
    const input = obs.elements.find((e) => e.name === "iframe input");
    assert(input, "observe should list the iframe input");
    assert(!input.id.startsWith("0-"), `iframe element should have nonzero frame index, got ${input.id}`);
  });

  await test("type into input inside iframe via selector", async () => {
    await send("type", { tab_id: tabId, selector: "#iframe-input", text: "framed" });
    const val = await send("eval_js", { tab_id: tabId, code: `${frameEval("#iframe-input")}.value` });
    assertEqual(val, "framed");
  });

  await test("click button inside iframe translates coordinates", async () => {
    await send("click", { tab_id: tabId, selector: "#iframe-btn" });
    const text = await send("eval_js", { tab_id: tabId, code: `${frameEval("#iframe-btn")}.textContent` });
    assertEqual(text, "Iframe Clicked!");
  });

  await test("type newlines into textarea inside iframe", async () => {
    await send("type", { tab_id: tabId, selector: "#iframe-textarea", text: "one\ntwo" });
    const val = await send("eval_js", { tab_id: tabId, code: `${frameEval("#iframe-textarea")}.value` });
    assertEqual(val, "one\ntwo");
  });

  await test("wait_for element inside iframe", async () => {
    const result = await send("wait_for", { tab_id: tabId, selector: "#iframe-btn", timeout: 3000 });
    assert(result.found, "should find iframe element");
  });

  // ---- a11y addressing (role + name) ----
  console.log(yellow("\n--- a11y addressing ---"));
  await test("click by role+name", async () => {
    await send("eval_js", { tab_id: tabId, code: `(() => { const b = document.getElementById('counter-btn'); b.dataset.count = '0'; b.textContent = 'Count: 0'; })()` });
    const result = await send("click", { tab_id: tabId, role: "button", name: "Count: 0" });
    assertEqual(result.method, "a11y");
    const count = await send("eval_js", { tab_id: tabId, code: `document.getElementById('counter-btn').dataset.count` });
    assertEqual(count, "1");
  });

  await test("type by role+name reaches shadow DOM", async () => {
    const result = await send("type", { tab_id: tabId, role: "textbox", name: "shadow input", text: "via a11y" });
    assertEqual(result.method, "a11y");
    const val = await send("eval_js", { tab_id: tabId, code: `${shadowEval("#shadow-input")}.value` });
    assertEqual(val, "via a11y");
  });

  await test("type by role+name reaches iframe", async () => {
    await send("type", { tab_id: tabId, role: "textbox", name: "iframe input", text: "framed a11y" });
    const val = await send("eval_js", { tab_id: tabId, code: `${frameEval("#iframe-input")}.value` });
    assertEqual(val, "framed a11y");
  });

  await test("type by role+name with clear replaces content", async () => {
    await send("type", { tab_id: tabId, role: "textbox", name: "shadow input", text: "replaced", clear: true });
    const val = await send("eval_js", { tab_id: tabId, code: `${shadowEval("#shadow-input")}.value` });
    assertEqual(val, "replaced");
  });

  await test("wait_for by role+name", async () => {
    const result = await send("wait_for", { tab_id: tabId, role: "textbox", name: "shadow editor", timeout: 3000 });
    assert(result.found, "should find by role+name");
  });

  await test("click by role+name for nonexistent throws", async () => {
    try {
      await send("click", { tab_id: tabId, role: "button", name: "No Such Button Anywhere" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("not found"), `Unexpected: ${err.message}`);
    }
  });

  // ---- press_key ----
  console.log(yellow("\n--- press_key ---"));
  await test("press_key select-all + backspace clears input", async () => {
    await send("type", { tab_id: tabId, selector: "#name-input", text: "wipe me", clear: true });
    await send("click", { tab_id: tabId, selector: "#name-input" });
    await send("press_key", { tab_id: tabId, key: "a", modifiers: ["Control"] });
    await send("press_key", { tab_id: tabId, key: "Backspace" });
    const val = await send("eval_js", { tab_id: tabId, code: `document.getElementById('name-input').value` });
    assertEqual(val, "");
  });

  await test("press_key types a character into focused element", async () => {
    await send("click", { tab_id: tabId, selector: "#name-input" });
    await send("press_key", { tab_id: tabId, key: "x" });
    const val = await send("eval_js", { tab_id: tabId, code: `document.getElementById('name-input').value` });
    assertEqual(val, "x");
  });

  await test("press_key unknown key throws", async () => {
    try {
      await send("press_key", { tab_id: tabId, key: "NotAKey" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("Unknown key"), `Unexpected: ${err.message}`);
    }
  });

  // ---- fill_form ----
  console.log(yellow("\n--- fill_form ---"));
  await test("fill_form fills multiple fields", async () => {
    const result = await send("fill_form", {
      tab_id: tabId,
      fields: [
        { selector: "#name-input", value: "Test User" },
        { selector: "#email-input", value: "test@example.com" },
      ],
    });
    assertEqual(result.filled, 2);
    const name = await send("eval_js", { tab_id: tabId, code: `document.getElementById('name-input').value` });
    assertEqual(name, "Test User");
  });

  await test("fill_form handles missing elements gracefully", async () => {
    const result = await send("fill_form", {
      tab_id: tabId,
      fields: [
        { selector: "#name-input", value: "Valid" },
        { selector: "#nonexistent", value: "Invalid" },
      ],
    });
    assertEqual(result.filled, 1);
    assertEqual(result.total, 2);
  });

  await test("fill_form without fields throws", async () => {
    try {
      await send("fill_form", { tab_id: tabId });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("Missing required parameter"), `Unexpected: ${err.message}`);
    }
  });

  // ---- eval_js ----
  console.log(yellow("\n--- eval_js ---"));
  await test("eval_js returns numeric result", async () => {
    assertEqual(await send("eval_js", { tab_id: tabId, code: "2 + 2" }), 4);
  });

  await test("eval_js accesses DOM", async () => {
    assertEqual(await send("eval_js", { tab_id: tabId, code: "document.title" }), "Browser Bridge Test Page");
  });

  await test("eval_js expression param works", async () => {
    assertEqual(await send("eval_js", { tab_id: tabId, expression: "window.location.protocol" }), "file:");
  });

  await test("eval_js without code throws", async () => {
    try {
      await send("eval_js", { tab_id: tabId });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("Missing required parameter"), `Unexpected: ${err.message}`);
    }
  });

  await test("eval_js syntax error throws", async () => {
    try {
      await send("eval_js", { tab_id: tabId, code: "{{invalid}}" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.length > 0, "Should have error message");
    }
  });

  // ---- wait_for ----
  console.log(yellow("\n--- wait_for ---"));
  await test("wait_for existing element resolves immediately", async () => {
    const result = await send("wait_for", { tab_id: tabId, selector: "#title" });
    assert(result.found, "Should find element");
  });

  await test("wait_for dynamic element after click", async () => {
    await send("eval_js", { tab_id: tabId, code: "document.getElementById('dynamic-el')?.remove()" });
    await send("click", { tab_id: tabId, selector: "#add-element-btn" });
    const result = await send("wait_for", { tab_id: tabId, selector: "#dynamic-el", timeout: 5000 });
    assert(result.found, "Should find dynamic element");
  });

  await test("wait_for timeout for nonexistent", async () => {
    try {
      await send("wait_for", { tab_id: tabId, selector: "#never", timeout: 1000 });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("Timed out"), `Unexpected: ${err.message}`);
    }
  });

  // ---- scroll ----
  console.log(yellow("\n--- scroll ---"));
  await test("scroll window", async () => {
    const result = await send("scroll", { tab_id: tabId, y: 100 });
    assertEqual(result.selector, "window");
  });

  await test("scroll specific element", async () => {
    await send("scroll", { tab_id: tabId, y: 50, selector: "#scroll-container" });
    const scrollTop = await send("eval_js", { tab_id: tabId, code: `document.getElementById('scroll-container').scrollTop` });
    assert(scrollTop > 0, `Expected scrollTop > 0, got ${scrollTop}`);
  });

  await test("scroll nonexistent element throws", async () => {
    try {
      await send("scroll", { tab_id: tabId, selector: "#nope" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("not found"), `Unexpected: ${err.message}`);
    }
  });

  // ---- screenshot ----
  console.log(yellow("\n--- screenshot ---"));
  await test("screenshot returns valid PNG base64", async () => {
    const data = await send("screenshot", { tab_id: tabId });
    assert(typeof data === "string" && data.length > 100, "Data too short");
    const buf = Buffer.from(data, "base64");
    assert(buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71, "Not valid PNG");
  });

  // ---- error handling ----
  console.log(yellow("\n--- error handling ---"));
  await test("unknown action returns error", async () => {
    try {
      await send("totally_fake_action");
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.includes("Unknown action"), `Unexpected: ${err.message}`);
    }
  });

  // ---- Summary ----
  console.log(cyan("\n=== Results ==="));
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${green(`${passed} passed`)}, ${failed > 0 ? red(`${failed} failed`) : "0 failed"}`);
  if (failed > 0) {
    console.log(red("\nFailed tests:"));
    for (const r of results.filter((r) => !r.pass)) {
      console.log(red(`  - ${r.name}: ${r.error}`));
    }
  }
  console.log();
  return failed;
}

async function main() {
  copyExtension({ destDir: EXTENSION_PATH, wsPort: PORT });
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

  const wss = new WebSocketServer({ port: PORT });
  console.log(`WebSocket server listening on ws://localhost:${PORT}`);

  console.log("Launching Chrome with extension...");
  const browser = await puppeteer.launch({
    executablePath: process.env.BROWSER_PATH || "/usr/bin/brave-browser",
    headless: process.env.TEST_HEADLESS === "1",
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--disable-default-apps",
      ...(process.env.CI_NO_SANDBOX === "1" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    ],
    ignoreDefaultArgs: ["--disable-extensions", "--enable-automation", "--disable-component-extensions-with-background-pages"],
    userDataDir: PROFILE_DIR,
    defaultViewport: null,
  });

  console.log("Waiting for extension to connect...");

  try {
    await waitForConnection(wss, 15000);
    console.log(green("Extension connected!\n"));

    // Give it a moment to settle
    await new Promise((r) => setTimeout(r, 1000));

    const failed = await runTests();

    await browser.close();
    wss.close();
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(red(`\nFatal: ${err.message}`));
    await browser.close().catch(() => {});
    wss.close();
    process.exit(1);
  }
}

main();

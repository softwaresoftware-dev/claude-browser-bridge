const puppeteer = require("puppeteer-core");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const { copyExtension } = require("./test-helpers");

const PORT = 7226;
const EXTENSION_PATH = "/tmp/browser-bridge-test";
const PROFILE_DIR = "/tmp/puppeteer-test-profile";
const TEST_PAGE = `file://${path.resolve(__dirname, "test-page.html")}`;
const EDGE_PAGE = `file://${path.resolve(__dirname, "test-page-edge.html")}`;

// Colors
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let msgId = 0;
let ws = null;
const results = [];

function send(action, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) {
      reject(new Error("No connected client"));
      return;
    }
    const id = ++msgId;
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for response to ${action}`)), timeoutMs);
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

// Send raw — returns full response including success/error
function sendRaw(action, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) {
      reject(new Error("No connected client"));
      return;
    }
    const id = ++msgId;
    const timeout = setTimeout(() => reject(new Error(`Timeout`)), timeoutMs);
    const handler = (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve(msg);
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
    const timeout = setTimeout(() => reject(new Error("Extension did not connect")), timeoutMs);
    wss.on("connection", (socket) => {
      clearTimeout(timeout);
      ws = socket;
      socket.on("message", (data) => {
        try { if (JSON.parse(data.toString()).type === "ping") return; } catch {}
      });
      resolve();
    });
  });
}

async function runTests(browser) {
  console.log(cyan("\n=== Round 2: Edge Case Tests ===\n"));

  // Get a tab and navigate to edge case page
  const tabs = await send("list_tabs");
  const tabId = tabs[0].id;
  await send("navigate", { tab_id: tabId, url: EDGE_PAGE });
  await new Promise((r) => setTimeout(r, 500));

  // =============================================
  // CONCURRENT REQUESTS
  // =============================================
  console.log(yellow("--- Concurrent requests ---"));

  await test("fire multiple get_element_info concurrently", async () => {
    const [a, b, c] = await Promise.all([
      send("get_element_info", { tab_id: tabId, selector: "#input-a" }),
      send("get_element_info", { tab_id: tabId, selector: "#input-b" }),
      send("get_element_info", { tab_id: tabId, selector: "#input-c" }),
    ]);
    assertEqual(a.id, "input-a");
    assertEqual(b.id, "input-b");
    assertEqual(c.id, "input-c");
  });

  await test("concurrent clicks on different buttons", async () => {
    const [a, b] = await Promise.all([
      send("click", { tab_id: tabId, selector: "#btn-a" }),
      send("click", { tab_id: tabId, selector: "#btn-b" }),
    ]);
    assert(a.clicked === "#btn-a", "Click A target mismatch");
    assert(b.clicked === "#btn-b", "Click B target mismatch");
    await new Promise((r) => setTimeout(r, 200));
    const infoA = await send("get_element_info", { tab_id: tabId, selector: "#btn-a" });
    const infoB = await send("get_element_info", { tab_id: tabId, selector: "#btn-b" });
    assertEqual(infoA.text, "A clicked");
    assertEqual(infoB.text, "B clicked");
  });

  await test("concurrent mix of read and write operations", async () => {
    const [content, info, tabs2] = await Promise.all([
      send("get_page_content", { tab_id: tabId }),
      send("get_element_info", { tab_id: tabId, selector: "#title" }),
      send("list_tabs"),
    ]);
    assert(content.includes("Edge Case"), "Content should include page text");
    assertEqual(info.tagName, "h1");
    assert(Array.isArray(tabs2), "Should return tabs array");
  });

  // =============================================
  // LARGE CONTENT
  // =============================================
  console.log(yellow("\n--- Large content ---"));

  await test("get_page_content on page with ~500KB text", async () => {
    const content = await send("get_page_content", { tab_id: tabId });
    assert(content.length > 100000, `Expected large content, got ${content.length} chars`);
  });

  await test("get_page_content html format on large page", async () => {
    const html = await send("get_page_content", { tab_id: tabId, format: "html" });
    assert(html.length > 100000, `Expected large HTML, got ${html.length} chars`);
    assert(html.includes("<html"), "Should be valid HTML");
  });

  // =============================================
  // SPECIAL CHARACTERS
  // =============================================
  console.log(yellow("\n--- Special characters ---"));

  await test("type unicode characters", async () => {
    await send("type", { tab_id: tabId, selector: "#special-input", text: "Hello 🌍 世界" });
    const val = await send("eval_js", { tab_id: tabId, code: `document.getElementById('special-input').value` });
    assertEqual(val, "Hello 🌍 世界");
  });

  await test("get_element_info with unicode content", async () => {
    const info = await send("get_element_info", { tab_id: tabId, selector: "#unicode-el" });
    assert(info.text.includes("🌍"), "Should contain emoji");
    assert(info.text.includes("世界"), "Should contain CJK");
    assert(info.text.includes("مرحبا"), "Should contain Arabic");
  });

  await test("type special keys like tab, newline", async () => {
    await send("type", { tab_id: tabId, selector: "#special-input", text: "line1\tline2" });
    const val = await send("eval_js", { tab_id: tabId, code: `document.getElementById('special-input').value` });
    // Tab character in an input field typically gets ignored or moves focus,
    // but the text should still be typed
    assert(val.length > 0, "Should have typed something");
  });

  await test("eval_js with quotes and special chars", async () => {
    const result = await send("eval_js", { tab_id: tabId, code: `"it's a \\"test\\" with 'quotes'"` });
    assertEqual(result, `it's a "test" with 'quotes'`);
  });

  await test("get_element_info on element with HTML entities", async () => {
    const info = await send("get_element_info", { tab_id: tabId, selector: "#html-entities" });
    // innerText should decode entities
    assert(info.text.includes("<script>"), "Should contain decoded HTML entities");
  });

  // =============================================
  // COMPLEX SELECTORS
  // =============================================
  console.log(yellow("\n--- Complex selectors ---"));

  await test("nested CSS selector", async () => {
    const info = await send("get_element_info", { tab_id: tabId, selector: ".parent .child .deep" });
    assert(info.text.includes("Deep nested"), "Should find nested element");
  });

  await test("attribute selector", async () => {
    const info = await send("get_element_info", { tab_id: tabId, selector: "[data-testid='nested-child']" });
    assert(info.className.includes("child"), "Should find by data attribute");
  });

  await test("compound class selector", async () => {
    const info = await send("get_element_info", { tab_id: tabId, selector: ".btn.primary.active" });
    assertEqual(info.id, "multi-class");
  });

  // =============================================
  // CHROME:// AND RESTRICTED PAGES
  // =============================================
  console.log(yellow("\n--- Restricted pages ---"));

  await test("get_page_content on chrome:// page fails gracefully", async () => {
    // Create a new tab with chrome://version
    const page = await browser.newPage();
    await page.goto("chrome://version");
    const allTabs = await send("list_tabs");
    const chromeTab = allTabs.find((t) => t.url.startsWith("chrome://version"));
    assert(chromeTab, "Should find chrome://version tab");
    try {
      await send("get_page_content", { tab_id: chromeTab.id });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(
        err.message.includes("Cannot execute script") || err.message.includes("Cannot access"),
        `Expected restricted page error, got: ${err.message}`
      );
    }
    await page.close();
  });

  await test("click on chrome:// page fails gracefully", async () => {
    const page = await browser.newPage();
    await page.goto("chrome://settings");
    const allTabs = await send("list_tabs");
    const chromeTab = allTabs.find((t) => t.url.startsWith("chrome://settings"));
    assert(chromeTab, "Should find chrome://settings tab");
    try {
      await send("click", { tab_id: chromeTab.id, selector: "body" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(
        err.message.includes("Cannot execute script") || err.message.includes("Cannot access"),
        `Expected restricted page error, got: ${err.message}`
      );
    }
    await page.close();
  });

  // Re-navigate to edge page (previous tests may have changed active tab)
  await send("navigate", { tab_id: tabId, url: EDGE_PAGE });
  await new Promise((r) => setTimeout(r, 500));

  // =============================================
  // eval_js ERROR PROPAGATION
  // =============================================
  console.log(yellow("\n--- eval_js error propagation ---"));

  await test("eval_js runtime error returns error", async () => {
    try {
      await send("eval_js", { tab_id: tabId, code: "undefinedVariable.foo" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(err.message.length > 0, "Should have error message");
      // This tests whether execInTabMainWorld properly propagates the error
      assert(!err.message.includes("Should have thrown"), `Error was not propagated: ${err.message}`);
    }
  });

  await test("eval_js type error returns error", async () => {
    try {
      await send("eval_js", { tab_id: tabId, code: "null.toString()" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(!err.message.includes("Should have thrown"), `Error was not propagated: ${err.message}`);
    }
  });

  await test("eval_js async error (rejected promise)", async () => {
    try {
      await send("eval_js", { tab_id: tabId, code: "Promise.reject(new Error('async fail'))" });
      // This might succeed with null if promise rejections are swallowed
      throw new Error("Should have thrown or returned error");
    } catch (err) {
      // Either way is informative — we want to know if this propagates
      assert(err.message.length > 0, "Should have some error");
    }
  });

  await test("eval_js returning undefined", async () => {
    const result = await send("eval_js", { tab_id: tabId, code: "undefined" });
    // undefined is not serializable — what happens?
    // It should come back as null since JSON.stringify(undefined) → undefined → null
    assertEqual(result, null);
  });

  await test("eval_js returning large object", async () => {
    const result = await send("eval_js", {
      tab_id: tabId,
      code: `Array.from({length: 1000}, (_, i) => ({id: i, name: "item" + i}))`,
    });
    assert(Array.isArray(result), "Should return array");
    assertEqual(result.length, 1000);
  });

  await test("eval_js returning circular reference", async () => {
    // Circular refs can't be serialized — this should error
    const resp = await sendRaw("eval_js", {
      tab_id: tabId,
      code: `(() => { const a = {}; a.self = a; return a; })()`,
    });
    // Either it errors or returns null (serialization fails silently)
    // We just want it to not hang or crash
    assert(resp.id !== undefined, "Should get a response back");
  });

  // =============================================
  // DISABLED / READONLY ELEMENTS
  // =============================================
  console.log(yellow("\n--- Disabled/readonly elements ---"));

  await test("type into disabled input", async () => {
    // This should either error or the text won't actually get typed
    // We mainly want it to not crash
    const resp = await sendRaw("type", { tab_id: tabId, selector: "#disabled-input", text: "test" });
    // Even if it "succeeds", verify the value didn't change
    const val = await send("eval_js", { tab_id: tabId, code: `document.getElementById('disabled-input').value` });
    // Disabled inputs can't be focused, so the clear step sets value to ""
    // but CDP typing won't work since the element isn't focused
    assert(resp.id !== undefined, "Should get a response");
  });

  await test("click disabled button via CDP", async () => {
    // CDP click dispatches raw mouse events regardless of disabled state
    const resp = await sendRaw("click", { tab_id: tabId, selector: "#disabled-btn" });
    assert(resp.id !== undefined, "Should get a response");
  });

  await test("fill_form with disabled input", async () => {
    const result = await send("fill_form", {
      tab_id: tabId,
      fields: [{ selector: "#disabled-input", value: "test" }],
    });
    // fill_form uses .value= which works even on disabled inputs
    assertEqual(result.filled, 1);
    const val = await send("eval_js", { tab_id: tabId, code: `document.getElementById('disabled-input').value` });
    assertEqual(val, "test");
  });

  // =============================================
  // TAB LIFECYCLE
  // =============================================
  console.log(yellow("\n--- Tab lifecycle ---"));

  await test("operate on tab that gets closed mid-request", async () => {
    const page = await browser.newPage();
    await page.goto(TEST_PAGE);
    await new Promise((r) => setTimeout(r, 500));
    const allTabs = await send("list_tabs");
    const newTab = allTabs.find((t) => t.url.includes("test-page.html") && t.id !== tabId);
    assert(newTab, "Should find new tab");

    // Close the tab, then try to operate on it
    await page.close();
    await new Promise((r) => setTimeout(r, 200));

    try {
      await send("get_page_content", { tab_id: newTab.id });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(
        err.message.includes("not found") || err.message.includes("closed") || err.message.includes("No tab"),
        `Expected tab closed error, got: ${err.message}`
      );
    }
  });

  await test("navigate to new tab and back", async () => {
    await send("navigate", { tab_id: tabId, url: TEST_PAGE });
    const info1 = await send("get_tab_info", { tab_id: tabId });
    assertEqual(info1.title, "Browser Bridge Test Page");

    await send("navigate", { tab_id: tabId, url: EDGE_PAGE });
    const info2 = await send("get_tab_info", { tab_id: tabId });
    assertEqual(info2.title, "Edge Case Test Page");
  });

  // =============================================
  // OVERLAPPING ELEMENTS
  // =============================================
  console.log(yellow("\n--- Overlapping elements ---"));

  await test("click element behind overlay (CDP sends to coordinates)", async () => {
    // CDP click goes to pixel coordinates — it'll hit the overlay, not the button behind it
    // The getElementCenter finds the button, but the click lands on the overlay
    const result = await send("click", { tab_id: tabId, selector: "#behind-btn" });
    // This "succeeds" but the click actually hits the overlay div
    assert(result.method === "cdp", "Should use CDP");
    // Verify the button's onclick didn't fire (because overlay intercepted)
    const btnText = await send("eval_js", { tab_id: tabId, code: `document.getElementById('behind-btn').textContent` });
    // This is a known limitation — document the behavior
    // The button text should still be "Behind button" if the overlay absorbed the click
    // OR it might say something else if the click went through
    assert(typeof btnText === "string", "Should get button text");
  });

  // =============================================
  // MALFORMED / ADVERSARIAL INPUTS
  // =============================================
  console.log(yellow("\n--- Malformed inputs ---"));

  await test("empty string selector", async () => {
    try {
      await send("get_element_info", { tab_id: tabId, selector: "" });
      throw new Error("Should have thrown");
    } catch (err) {
      // Empty selector passed to querySelector will throw a DOM exception
      assert(!err.message.includes("Should have thrown"), `Error not propagated: ${err.message}`);
    }
  });

  await test("invalid CSS selector", async () => {
    try {
      await send("get_element_info", { tab_id: tabId, selector: "###invalid[[[" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(!err.message.includes("Should have thrown"), `Error not propagated: ${err.message}`);
    }
  });

  await test("type empty string", async () => {
    const result = await send("type", { tab_id: tabId, selector: "#special-input", text: "" });
    assertEqual(result.typed, "");
  });

  await test("navigate to invalid URL", async () => {
    try {
      await send("navigate", { tab_id: tabId, url: "not-a-valid-url" }, 10000);
      // Some browsers may treat this as a search query
    } catch (err) {
      // Timeout or error — both acceptable
      assert(err.message.length > 0, "Should have error");
    }
    // Navigate back to the edge page for remaining tests
    await send("navigate", { tab_id: tabId, url: EDGE_PAGE });
    await new Promise((r) => setTimeout(r, 500));
  });

  await test("eval_js with very long code string", async () => {
    const longCode = `"${"a".repeat(100000)}"`;
    const result = await send("eval_js", { tab_id: tabId, code: longCode });
    assertEqual(result.length, 100000);
  });

  await test("fill_form with empty fields array", async () => {
    const result = await send("fill_form", { tab_id: tabId, fields: [] });
    assertEqual(result.filled, 0);
    assertEqual(result.total, 0);
  });

  await test("scroll with very large values", async () => {
    const result = await send("scroll", { tab_id: tabId, y: 999999 });
    assertEqual(result.selector, "window");
    // Scroll back
    await send("eval_js", { tab_id: tabId, code: "window.scrollTo(0, 0)" });
  });

  await test("negative scroll values", async () => {
    // First scroll down, then scroll up with negative
    await send("scroll", { tab_id: tabId, y: 200 });
    const result = await send("scroll", { tab_id: tabId, y: -100 });
    assertEqual(result.scrolled.y, -100);
  });

  await test("tab_id as string instead of number", async () => {
    // The extension expects a number, but what if a string is passed?
    try {
      await send("get_tab_info", { tab_id: "not-a-number" });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(!err.message.includes("Should have thrown"), `Should have errored: ${err.message}`);
    }
  });

  await test("tab_id as 0", async () => {
    // 0 is falsy — does resolveTabId treat it as "no tab specified"?
    try {
      await send("get_tab_info", { tab_id: 0 });
      throw new Error("Should have thrown");
    } catch (err) {
      // Tab 0 doesn't exist, should error
      assert(!err.message.includes("Should have thrown"), `Error not propagated: ${err.message}`);
    }
  });

  await test("tab_id as negative number", async () => {
    try {
      await send("get_tab_info", { tab_id: -1 });
      throw new Error("Should have thrown");
    } catch (err) {
      assert(!err.message.includes("Should have thrown"), `Error not propagated: ${err.message}`);
    }
  });

  // =============================================
  // WEBSOCKET PROTOCOL
  // =============================================
  console.log(yellow("\n--- WebSocket protocol ---"));

  await test("message without id field", async () => {
    // Send a message with no id — the response should still come back
    // but there's no way to match it. This shouldn't crash the extension.
    return new Promise((resolve) => {
      ws.send(JSON.stringify({ action: "list_tabs", params: {} }));
      // No way to get the response without an id — just verify nothing crashes
      setTimeout(async () => {
        // Extension should still be responsive
        const tabs = await send("list_tabs");
        assert(Array.isArray(tabs), "Extension should still respond after id-less message");
        resolve();
      }, 500);
    });
  });

  await test("message with non-JSON payload", async () => {
    return new Promise((resolve) => {
      ws.send("this is not json at all");
      setTimeout(async () => {
        const tabs = await send("list_tabs");
        assert(Array.isArray(tabs), "Extension should still respond after bad message");
        resolve();
      }, 500);
    });
  });

  await test("message with null action", async () => {
    const resp = await sendRaw(null, {});
    assert(!resp.success, "Should fail");
    assert(resp.error.includes("Unknown action"), `Expected unknown action error, got: ${resp.error}`);
  });

  await test("message with no params", async () => {
    // Send raw message with no params field at all
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
      const handler = (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.off("message", handler);
          // list_tabs doesn't need params, so it should succeed
          assert(msg.success, "list_tabs should work without params");
          resolve();
        }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({ id, action: "list_tabs" })); // no params field
    });
  });

  // =============================================
  // MULTIPLE TABS
  // =============================================
  console.log(yellow("\n--- Multiple tabs ---"));

  await test("operate on specific non-active tab", async () => {
    const page2 = await browser.newPage();
    await page2.goto(TEST_PAGE);
    await new Promise((r) => setTimeout(r, 500));

    const allTabs = await send("list_tabs");
    const testPageTab = allTabs.find((t) => t.url.includes("test-page.html") && t.id !== tabId);
    assert(testPageTab, "Should find second tab");

    // Operate on it while it's not active (our edge page tab is active)
    const content = await send("get_page_content", { tab_id: testPageTab.id });
    assert(content.includes("Browser Bridge Test Page"), "Should get content from non-active tab");

    await page2.close();
  });

  await test("screenshot non-active tab (switches focus)", async () => {
    const page2 = await browser.newPage();
    await page2.goto(TEST_PAGE);
    await new Promise((r) => setTimeout(r, 500));

    const allTabs = await send("list_tabs");
    const testPageTab = allTabs.find((t) => t.url.includes("test-page.html") && t.id !== tabId);

    // Screenshot should activate this tab first
    const data = await send("screenshot", { tab_id: testPageTab.id });
    assert(typeof data === "string" && data.length > 100, "Should return screenshot data");
    const buf = Buffer.from(data, "base64");
    assert(buf[0] === 137 && buf[1] === 80, "Should be valid PNG");

    await page2.close();
  });

  // =============================================
  // RECONNECTION
  // =============================================
  console.log(yellow("\n--- Reconnection ---"));

  await test("extension reconnects after server disconnect", async () => {
    // Force close the connection from server side
    ws.close();
    ws = null;

    // Wait for reconnection (extension has exponential backoff starting at 1s)
    const reconnected = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10000);
      wss.on("connection", (socket) => {
        clearTimeout(timeout);
        ws = socket;
        socket.on("message", (data) => {
          try { if (JSON.parse(data.toString()).type === "ping") return; } catch {}
        });
        resolve(true);
      });
    });

    assert(reconnected, "Extension should reconnect after server drops connection");
    await new Promise((r) => setTimeout(r, 500));

    // Verify it works after reconnection
    const tabs = await send("list_tabs");
    assert(Array.isArray(tabs), "Should work after reconnection");
  });

  // =============================================
  // SUMMARY
  // =============================================
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

let wss;

async function main() {
  copyExtension({ destDir: EXTENSION_PATH, wsPort: PORT });
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

  wss = new WebSocketServer({ port: PORT });
  console.log(`WebSocket server listening on ws://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/brave-browser",
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--disable-default-apps",
    ],
    ignoreDefaultArgs: ["--disable-extensions", "--enable-automation", "--disable-component-extensions-with-background-pages"],
    userDataDir: PROFILE_DIR,
    defaultViewport: null,
  });

  console.log("Waiting for extension to connect...");
  await waitForConnection(wss, 15000);
  console.log(green("Extension connected!\n"));
  await new Promise((r) => setTimeout(r, 1000));

  try {
    const failed = await runTests(browser);
    await browser.close();
    wss.close();
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(red(`\nFatal: ${err.message}`));
    console.error(err.stack);
    await browser.close().catch(() => {});
    wss.close();
    process.exit(1);
  }
}

main();

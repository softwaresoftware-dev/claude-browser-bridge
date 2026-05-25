// End-to-end test for observe_a11y. Launches headless Brave with the extension
// loaded, points it at test-page.html, exercises the new action.
//
// Run: node test-observe-a11y.js

const puppeteer = require("puppeteer-core");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const { copyExtension } = require("./test-helpers");

const PORT = 7227;
const EXT_DST = "/tmp/browser-bridge-test-a11y";
const PROFILE_DIR = "/tmp/puppeteer-test-profile-a11y";
const TEST_PAGE = `file://${path.resolve(__dirname, "test-page.html")}`;

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

let msgId = 0;
let ws = null;
const results = [];

function send(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("No connected client"));
    const id = ++msgId;
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${action}`)), 15000);
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

function flatten(tree, acc = []) {
  for (const n of tree) {
    acc.push(n);
    if (n.children) flatten(n.children, acc);
  }
  return acc;
}

function findByName(tree, name) {
  return flatten(tree).find((n) => n.name === name);
}

function findByRole(tree, role) {
  return flatten(tree).filter((n) => n.role === role);
}

async function waitForConnection(wss, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Extension did not connect")), timeoutMs);
    wss.on("connection", (socket) => {
      clearTimeout(timeout);
      ws = socket;
      resolve();
    });
  });
}

async function runTests() {
  console.log(cyan("\n=== observe_a11y Test Suite ===\n"));

  let tabs = await send("list_tabs");
  const tabId = tabs[0].id;
  await send("navigate", { tab_id: tabId, url: TEST_PAGE });
  await new Promise((r) => setTimeout(r, 500));

  let snap1;
  await test("returns expected top-level shape", async () => {
    snap1 = await send("observe_a11y", { tab_id: tabId });
    assert(snap1.url.includes("test-page.html"), `url: ${snap1.url}`);
    assertEqual(snap1.title, "Browser Bridge Test Page");
    assert(snap1.viewport.w > 0 && snap1.viewport.h > 0, "viewport");
    assert(Array.isArray(snap1.tree), "tree is array");
    assert(snap1.tree.length > 0, "tree not empty");
  });

  await test("heading nodes have level + name", async () => {
    const h1 = findByRole(snap1.tree, "heading").find((n) => n.level === 1);
    assert(h1, "no h1 found");
    assertEqual(h1.name, "Browser Bridge Test Page");
    const h2s = findByRole(snap1.tree, "heading").filter((n) => n.level === 2);
    assert(h2s.length >= 3, `expected >=3 h2s, got ${h2s.length}`);
  });

  await test("textbox inputs get role+name from placeholder", async () => {
    const textboxes = findByRole(snap1.tree, "textbox");
    const names = textboxes.map((t) => t.name);
    assert(names.includes("Name"), `expected Name, got ${names}`);
    assert(names.includes("Email"), `expected Email, got ${names}`);
    assert(names.includes("Search"), `expected Search, got ${names}`);
  });

  await test("buttons have role+name", async () => {
    const submit = findByName(snap1.tree, "Submit");
    assert(submit, "no Submit button");
    assertEqual(submit.role, "button");
    assert(findByName(snap1.tree, "Click Me"), "no Click Me");
    assert(findByName(snap1.tree, "Count: 0"), "no counter");
  });

  await test("hidden + zero-size elements excluded", async () => {
    const all = flatten(snap1.tree);
    const hidden = all.find((n) => n.name === "This is hidden");
    assert(!hidden, "should have excluded display:none");
  });

  await test("every kept node has stable bb-id", async () => {
    const all = flatten(snap1.tree);
    for (const n of all) {
      assert(/^0-\d+$/.test(n.id), `bad id: ${n.id}`);
    }
    const ids = all.map((n) => n.id);
    assertEqual(new Set(ids).size, ids.length, "duplicate ids");
  });

  let snap2;
  await test("ref stability: 2nd snapshot reuses same ids", async () => {
    snap2 = await send("observe_a11y", { tab_id: tabId });
    const submit1 = findByName(snap1.tree, "Submit");
    const submit2 = findByName(snap2.tree, "Submit");
    assertEqual(submit2.id, submit1.id);
    const click1 = findByName(snap1.tree, "Click Me");
    const click2 = findByName(snap2.tree, "Click Me");
    assertEqual(click2.id, click1.id);
  });

  await test("click via bb-id from a11y snapshot works", async () => {
    const click = findByName(snap1.tree, "Click Me");
    // click action accepts selector — convert id back to data-bb-id selector
    await send("click", { tab_id: tabId, selector: `[data-bb-id="${click.id}"]` });
    await new Promise((r) => setTimeout(r, 300));
    const info = await send("get_element_info", { tab_id: tabId, selector: `[data-bb-id="${click.id}"]` });
    assertEqual(info.text, "Clicked!");
  });

  await test("type via bb-id works + value shows in next snapshot", async () => {
    const name = findByName(snap1.tree, "Name");
    await send("type", { tab_id: tabId, selector: `[data-bb-id="${name.id}"]`, text: "Alice" });
    const snap3 = await send("observe_a11y", { tab_id: tabId });
    const nameAfter = flatten(snap3.tree).find((n) => n.id === name.id);
    assertEqual(nameAfter.value, "Alice");
  });

  await test("text_only captures surrounding non-interactive text", async () => {
    // Inject a listitem with text + a nested button
    await send("eval_js", {
      tab_id: tabId,
      code: `
        const ul = document.createElement('ul');
        ul.id = 'order-list';
        ul.innerHTML = '<li>Delivered Mar 14 · $47.22 <button id="reorder-btn">Reorder</button></li>';
        document.body.appendChild(ul);
      `,
    });
    const snap = await send("observe_a11y", { tab_id: tabId });
    const list = flatten(snap.tree).find((n) => n.role === "list" && n.children?.some((c) => c.role === "listitem"));
    assert(list, "list not found");
    const li = list.children.find((c) => c.role === "listitem");
    assert(li.text_only, `text_only missing on listitem; got ${JSON.stringify(li)}`);
    assert(li.text_only.includes("Delivered Mar 14"), `text_only=${li.text_only}`);
    assert(li.text_only.includes("$47.22"), `text_only=${li.text_only}`);
    // The Reorder button text should NOT be in li.text_only (it's its own kept node)
    assert(!li.text_only.includes("Reorder"), `Reorder leaked into text_only: ${li.text_only}`);
    // The button should be a child
    const btn = li.children.find((c) => c.name === "Reorder");
    assert(btn, "Reorder button not nested");
  });

  await test("viewport_only filters off-screen elements", async () => {
    // Force scroll to top so test-page elements are in view, then viewport_only should match
    await send("scroll", { tab_id: tabId, y: -10000 });
    const snap = await send("observe_a11y", { tab_id: tabId, viewport_only: true });
    const all = flatten(snap.tree);
    // Without specific bbox info, just check we got *some* nodes and no `in_viewport: false`
    assert(all.length > 0, "viewport-only snapshot empty");
    const offScreen = all.filter((n) => n.in_viewport === false);
    assertEqual(offScreen.length, 0, `${offScreen.length} off-screen leaked into viewport_only`);
  });

  await test("dynamic new element gets a fresh id", async () => {
    await send("eval_js", {
      tab_id: tabId,
      code: `
        const b = document.createElement('button');
        b.id = 'fresh-btn';
        b.textContent = 'Fresh';
        document.body.appendChild(b);
      `,
    });
    const snap = await send("observe_a11y", { tab_id: tabId });
    const fresh = findByName(snap.tree, "Fresh");
    assert(fresh, "Fresh button not in snapshot");
    assert(/^0-\d+$/.test(fresh.id), `bad id ${fresh.id}`);
    // Old ids should still exist
    const click = findByName(snap.tree, "Clicked!");  // we clicked it earlier
    assert(click, "previously-clicked button missing");
  });

  console.log(cyan("\n=== Results ==="));
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${green(`${passed} passed`)}, ${failed > 0 ? red(`${failed} failed`) : "0 failed"}`);
  if (failed > 0) {
    console.log(red("\nFailed:"));
    for (const r of results.filter((r) => !r.pass)) {
      console.log(red(`  - ${r.name}: ${r.error}`));
    }
  }
  return failed;
}

async function main() {
  copyExtension({ destDir: EXT_DST, wsPort: PORT });
  console.log(`Extension copied to ${EXT_DST}, WS_URL → ws://127.0.0.1:${PORT}`);

  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

  const wss = new WebSocketServer({ port: PORT });
  console.log(`WebSocket server listening on ws://127.0.0.1:${PORT}`);

  console.log("Launching Brave with extension...");
  const browser = await puppeteer.launch({
    executablePath: process.env.BROWSER_PATH || "/usr/bin/brave-browser",
    headless: process.env.TEST_HEADLESS === "1",
    args: [
      `--disable-extensions-except=${EXT_DST}`,
      `--load-extension=${EXT_DST}`,
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

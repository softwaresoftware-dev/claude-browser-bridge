// Regression test: extension actions must return correct layout for
// backgrounded tabs whose pages pause themselves on visibilitychange.
//
// Reproduces the LinkedIn bug pattern: when document.visibilityState ===
// "hidden", such pages set display:none on chunks of UI; getBoundingClientRect
// returns zeros; clicks resolve to (0,0). Fix is Emulation.setFocusEmulationEnabled
// applied via CDP in _attachDebuggerImpl.

const puppeteer = require("puppeteer-core");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const { copyExtension, artifactDir } = require("./test-helpers");

const PORT = 7228;
const EXT_DST = artifactDir("backgrounded-tab-ext");
const PROFILE_DIR = artifactDir("backgrounded-tab-profile");

const PAGE_FILE = path.join(artifactDir("backgrounded-tab-fixtures"), "page.html");
fs.writeFileSync(PAGE_FILE, `<!doctype html>
<html><body style="margin:0">
  <button id="target" style="position:absolute;left:50px;top:100px;width:200px;height:80px">click me</button>
  <script>
    const target = document.getElementById("target");
    document.addEventListener("visibilitychange", () => {
      target.style.display = document.visibilityState === "hidden" ? "none" : "";
    });
  </script>
</body></html>`);
const PAGE = `file://${PAGE_FILE}`;

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

let ws = null;
let msgId = 0;
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

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

async function main() {
  copyExtension({ destDir: EXT_DST, wsPort: PORT });
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

  const wss = new WebSocketServer({ port: PORT });
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

  // Wait for the extension to connect.
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Extension did not connect")), 15000);
    wss.on("connection", (socket) => { clearTimeout(timeout); ws = socket; resolve(); });
  });
  await new Promise((r) => setTimeout(r, 1000));

  console.log(cyan("\n=== Backgrounded-tab Regression ===\n"));

  // Open the test page in tab A, then a blank tab B (B becomes active, A is backgrounded).
  const tabs = await send("list_tabs", { all_tabs: true });
  // First active tab in this session group
  const tabA = tabs[0].id;
  await send("navigate", { tab_id: tabA, url: PAGE });
  await new Promise((r) => setTimeout(r, 300));

  // Sanity baseline while tabA is foreground.
  await test("baseline: foreground tab reports real bbox", async () => {
    const info = await send("get_element_info", { tab_id: tabA, selector: "#target" });
    assert(info.boundingRect.width > 0, `expected width > 0, got ${JSON.stringify(info.boundingRect)}`);
  });

  // Background tabA by creating a new tab via puppeteer.
  const tabB = await browser.newPage();
  await tabB.bringToFront();
  await new Promise((r) => setTimeout(r, 500)); // let visibilitychange fire

  await test("backgrounded tab: get_element_info returns real bbox", async () => {
    const info = await send("get_element_info", { tab_id: tabA, selector: "#target" });
    assert(info.boundingRect.width > 0,
      `bbox collapsed on backgrounded tab — focus emulation not applied: ${JSON.stringify(info.boundingRect)}`);
    assert(info.boundingRect.top === 100,
      `top expected 100, got ${info.boundingRect.top}`);
  });

  await test("backgrounded tab: observe finds element with non-zero bbox", async () => {
    const result = await send("observe", { tab_id: tabA, include_screenshot: false });
    const target = result.elements.find((e) => e.tag === "button");
    assert(target, "button not found in observe output");
    const [left, top, width, height] = target.bbox;
    assert(width > 0 && height > 0,
      `observe bbox collapsed: ${JSON.stringify(target.bbox)}`);
  });

  await test("backgrounded tab: click lands on real coordinates", async () => {
    // Inject a click recorder. If our click resolves to (0,0), this stays empty.
    await send("eval_js", {
      tab_id: tabA,
      code: `window.__last_click = null; document.getElementById('target').addEventListener('click', (e) => { window.__last_click = { x: e.clientX, y: e.clientY }; });`,
    });
    await send("click", { tab_id: tabA, selector: "#target" });
    await new Promise((r) => setTimeout(r, 200));
    const recorded = await send("eval_js", {
      tab_id: tabA,
      code: `window.__last_click`,
    });
    assert(recorded, `click never reached the button (likely fired at (0,0))`);
    assert(recorded.x > 50 && recorded.x < 250, `clientX outside target: ${recorded.x}`);
    assert(recorded.y > 100 && recorded.y < 180, `clientY outside target: ${recorded.y}`);
  });

  await browser.close();
  wss.close();

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
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(red(`\nFatal: ${err.message}`));
  process.exit(1);
});

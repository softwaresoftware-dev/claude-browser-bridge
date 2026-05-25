// Experiment: do CDP interventions restore getBoundingClientRect on backgrounded tabs?
//
// We use a synthetic page that mimics LinkedIn's pattern: pauses layout work
// (intentionally yields and avoids re-rendering) when document.visibilityState
// becomes "hidden". Then we test combinations of:
//   - baseline (no intervention)
//   - chrome.debugger attached (no flags set)
//   - Emulation.setFocusEmulationEnabled(true)
//   - Page.setWebLifecycleState({state: "active"})
//   - both flags
//
// For each, we check whether elements report real bounding boxes.

const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const BROWSER = process.env.BROWSER_PATH || "/usr/bin/brave-browser";
const PROFILE = "/tmp/exp-backgrounded-tab-profile";

// A test page that mimics LinkedIn's visibility-aware rendering:
//   - On load, paints a 200x80 button at (50, 100).
//   - On visibilitychange→hidden, optionally hides the layout via display:none
//     to simulate "page paused itself."
// Two variants for comparison.
const PAGE_VANILLA = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><body style="margin:0">
  <button id="target" style="position:absolute;left:50px;top:100px;width:200px;height:80px">click me</button>
  <script>
    window.__report = () => {
      const el = document.getElementById("target");
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height, visibilityState: document.visibilityState };
    };
  </script>
</body></html>`)}`;

const PAGE_VISIBILITY_AWARE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><body style="margin:0">
  <button id="target" style="position:absolute;left:50px;top:100px;width:200px;height:80px">click me</button>
  <script>
    // Mimic LinkedIn-style: when tab becomes hidden, collapse layout.
    const target = document.getElementById("target");
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        target.style.display = "none";
      } else {
        target.style.display = "";
      }
    });
    window.__report = () => {
      const el = document.getElementById("target");
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height, visibilityState: document.visibilityState };
    };
  </script>
</body></html>`)}`;

async function snapshot(page, label) {
  const r = await page.evaluate(() => window.__report());
  console.log(`  ${label.padEnd(50)} bbox=${JSON.stringify(r)}`);
  return r;
}

async function attachCDP(page) {
  const session = await page.createCDPSession();
  return session;
}

async function setLifecycleActive(session) {
  await session.send("Page.setWebLifecycleState", { state: "active" });
}

async function setFocusEmulation(session, enabled) {
  await session.send("Emulation.setFocusEmulationEnabled", { enabled });
}

async function runFor(pageDataUrl, label) {
  console.log(`\n=== ${label} ===`);
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: false,
    userDataDir: PROFILE,
    defaultViewport: null,
  });

  // tabA holds the target page; tabB will background it.
  const tabA = (await browser.pages())[0];
  await tabA.goto(pageDataUrl);

  // Sanity: while tabA is foreground, bbox should be real.
  await snapshot(tabA, "(foreground, baseline)");

  // Background it by opening tabB and bringing it to front.
  const tabB = await browser.newPage();
  await tabB.bringToFront();
  await new Promise((r) => setTimeout(r, 300)); // let visibilitychange fire

  await snapshot(tabA, "(backgrounded, no intervention)");

  // Attach CDP and re-measure with each combination.
  const session = await attachCDP(tabA);

  await snapshot(tabA, "(backgrounded, CDP attached, no flags)");

  // Test setWebLifecycleState alone.
  await setLifecycleActive(session);
  await snapshot(tabA, "(backgrounded, ONLY setWebLifecycleState=active)");

  // Test setFocusEmulationEnabled alone (after toggling lifecycle off doesn't
  // exist; just keep stacking and see if it changes anything).
  await setFocusEmulation(session, true);
  await snapshot(tabA, "(backgrounded, + setFocusEmulationEnabled)");

  // Reverse: turn off focus emulation, keep lifecycle.
  await setFocusEmulation(session, false);
  await snapshot(tabA, "(backgrounded, focusEmu OFF, lifecycle still active)");

  // Re-foreground for sanity check.
  await tabA.bringToFront();
  await new Promise((r) => setTimeout(r, 300));
  await snapshot(tabA, "(foreground again, after interventions)");

  await browser.close();
}

(async () => {
  await runFor(PAGE_VANILLA, "Vanilla page (no visibility handler)");
  await runFor(PAGE_VISIBILITY_AWARE, "Visibility-aware page (LinkedIn-style)");
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

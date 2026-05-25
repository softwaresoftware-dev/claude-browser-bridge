// Shared setup for browser-bridge extension tests.
//
// Each runner copies the extension to a unique /tmp dir with the WS port
// patched into background.js, then launches Brave/Chromium pointed at it.
// Centralizing here keeps the three runners in sync as the extension grows.

const fs = require("fs");
const path = require("path");

const EXT_SRC = path.resolve(__dirname, "../../extension");
const ARTIFACTS_ROOT = path.resolve(__dirname, ".test-artifacts");

// Returns (and ensures the existence of) a per-suite artifact directory.
// Use these for the extension copy + Chrome profile so they live in the repo
// (gitignored) rather than /tmp, making post-failure inspection easy.
function artifactDir(name) {
  const dir = path.join(ARTIFACTS_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const EXTENSION_FILES = [
  "background.js",
  "manifest.json",
  "observer.js",
  "observer-a11y.js",
];

function copyExtension({ destDir, wsPort }) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(path.join(destDir, "icons"), { recursive: true });

  for (const f of EXTENSION_FILES) {
    let content = fs.readFileSync(path.join(EXT_SRC, f), "utf8");
    if (f === "background.js") {
      content = content.replace(
        /const WS_URL = .*;/,
        `const WS_URL = "ws://127.0.0.1:${wsPort}";`
      );
    }
    fs.writeFileSync(path.join(destDir, f), content);
  }
  for (const icon of fs.readdirSync(path.join(EXT_SRC, "icons"))) {
    fs.copyFileSync(
      path.join(EXT_SRC, "icons", icon),
      path.join(destDir, "icons", icon)
    );
  }
}

module.exports = { copyExtension, EXT_SRC, artifactDir };

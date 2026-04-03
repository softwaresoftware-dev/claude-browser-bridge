import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node18",
};

// daemon has no top-level await → CJS is fine and avoids ws/ESM compat issues
await build({
  ...shared,
  format: "cjs",
  entryPoints: ["server/daemon.js"],
  outfile: "dist/daemon.cjs",
});

// index uses top-level await → must be ESM
// No ws dependency here (only @modelcontextprotocol/sdk + zod + node builtins)
await build({
  ...shared,
  format: "esm",
  entryPoints: ["server/index.js"],
  outfile: "dist/index.mjs",
});

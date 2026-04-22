const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function parseLevel(raw) {
  if (raw == null) return LEVELS.info;
  const key = String(raw).trim().toLowerCase();
  return LEVELS[key] ?? LEVELS.info;
}

const activeLevel = parseLevel(process.env.CLAUDE_PLUGIN_OPTION_LOG_LEVEL);

function emit(levelName, component, args) {
  if (LEVELS[levelName] < activeLevel) return;
  process.stderr.write(`[${levelName}] [${component}] ${args.join(" ")}\n`);
}

export function createLogger(component) {
  return {
    debug: (...args) => emit("debug", component, args),
    info: (...args) => emit("info", component, args),
    warn: (...args) => emit("warn", component, args),
    error: (...args) => emit("error", component, args),
  };
}

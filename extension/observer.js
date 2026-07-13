// observer.js — DOM walker + interactivity detector injected into target tab.
//
// Declared as a classic global via importScripts('observer.js') in
// background.js. chrome.scripting.executeScript serializes the function body
// via Function.prototype.toString() and runs it in the target's isolated
// world, so this function must be entirely self-contained: no closures, no
// module imports, no references to anything outside its own body.

function browserBridgeObserve(opts) {
  opts = opts || {};
  const viewportOnly = !!opts.viewportOnly;

  // Frame identity and root-viewport offset. This function is injected into
  // every frame; each invocation figures out where its frame sits. Hidden
  // frames (display:none / opacity 0 preload frames) and cross-origin frames
  // (offsets unknowable) return null and are dropped by the caller.
  let frameIndex = 0;
  let offsetX = 0, offsetY = 0;
  let rootW = window.innerWidth, rootH = window.innerHeight;
  if (window !== window.top) {
    frameIndex = 1000 + Math.floor(Math.random() * 9000);
    try {
      for (let i = 0; i < window.top.frames.length; i++) {
        if (window.top.frames[i] === window) { frameIndex = i + 1; break; }
      }
      let win = window;
      while (win.frameElement) {
        const cs = getComputedStyle(win.frameElement);
        if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) {
          return null;
        }
        const fr = win.frameElement.getBoundingClientRect();
        offsetX += fr.left + (win.frameElement.clientLeft || 0);
        offsetY += fr.top + (win.frameElement.clientTop || 0);
        win = win.parent;
      }
      rootW = window.top.innerWidth;
      rootH = window.top.innerHeight;
    } catch {
      return null;
    }
  }

  const BB_ATTR = "data-bb-id";
  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "meta", "link", "template", "head",
  ]);
  const INTERACTIVE_TAGS = new Set([
    "button", "input", "select", "textarea", "a",
    "details", "summary", "option", "optgroup",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "radio", "checkbox", "tab", "textbox", "combobox",
    "slider", "spinbutton", "search", "searchbox", "switch",
    "row", "cell", "gridcell",
  ]);
  const EVENT_ATTRS = [
    "onclick", "onmousedown", "onmouseup", "onkeydown", "onkeyup", "tabindex",
  ];
  const ARIA_STATE_ATTRS = [
    "aria-checked", "aria-expanded", "aria-pressed", "aria-selected",
    "aria-required", "aria-autocomplete",
  ];
  const SEARCH_TERMS = [
    "search", "magnify", "glass", "lookup", "query", "searchbox",
  ];

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "html" || tag === "body") return false;

    if (INTERACTIVE_TAGS.has(tag)) {
      // labels with `for` proxy to another input — excluding them avoids
      // double-activation of the real target.
      if (tag === "label" && el.hasAttribute("for")) return false;
      return true;
    }

    for (const attr of EVENT_ATTRS) {
      if (el.hasAttribute(attr)) return true;
    }

    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;

    for (const attr of ARIA_STATE_ATTRS) {
      if (el.hasAttribute(attr)) return true;
    }

    const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
    const id = (el.id || "").toLowerCase();
    if (SEARCH_TERMS.some((t) => cls.includes(t) || id.includes(t))) return true;

    try {
      if (getComputedStyle(el).cursor === "pointer") return true;
    } catch {}

    return false;
  }

  function isVisible(el, rect) {
    // Bootstrap-style file inputs are often opacity:0 but functional.
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && el.type === "file") return true;

    try {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      if (parseFloat(cs.opacity) === 0) return false;
    } catch {
      return false;
    }
    // Size-0 elements are kept: invisible clickable overlays are common.
    if (rect.width < 0 || rect.height < 0) return false;
    return true;
  }

  function inViewport(rect) {
    return rect.top + offsetY < rootH && rect.bottom + offsetY > 0
        && rect.left + offsetX < rootW && rect.right + offsetX > 0;
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim().slice(0, 120);
    const alt = el.getAttribute("alt");
    if (alt) return alt.trim().slice(0, 120);
    const title = el.getAttribute("title");
    if (title) return title.trim().slice(0, 120);
    const text = (el.innerText || el.textContent || "").trim();
    return text.slice(0, 120);
  }

  function strippedValue(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const v = el.value;
      if (typeof v === "string" && v) return v.slice(0, 80);
    }
    return null;
  }

  // Clear stale ids everywhere we stamp them — including inside open shadow
  // roots, which document.querySelectorAll can't reach.
  (function clearStale(root) {
    for (const stale of root.querySelectorAll(`[${BB_ATTR}]`)) {
      stale.removeAttribute(BB_ATTR);
    }
    for (const host of root.querySelectorAll("*")) {
      if (host.shadowRoot) clearStale(host.shadowRoot);
    }
  })(document);

  const elements = [];
  let nextIdx = 0;

  function walk(root, depth) {
    if (depth > 60) return;
    const children = root.children;
    if (!children) return;
    for (const child of children) {
      if (!(child instanceof Element)) continue;
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;

      const rect = child.getBoundingClientRect();
      if (isInteractive(child) && isVisible(child, rect)) {
        const inView = inViewport(rect);
        if (!viewportOnly || inView) {
          const bbId = `${frameIndex}-${nextIdx++}`;
          child.setAttribute(BB_ATTR, bbId);
          const entry = { id: bbId, tag };
          const role = child.getAttribute("role");
          if (role) entry.role = role;
          const type = child.getAttribute("type");
          if (type) entry.type = type;
          const name = accessibleName(child);
          if (name) entry.name = name;
          if (!viewportOnly) entry.inViewport = inView;
          const val = strippedValue(child);
          if (val) entry.value = val;
          if (tag === "a" && child.href) entry.href = child.href;
          entry.bbox = [
            Math.round(rect.left + offsetX),
            Math.round(rect.top + offsetY),
            Math.round(rect.width),
            Math.round(rect.height),
          ];
          elements.push(entry);
        }
      }

      if (child.shadowRoot) walk(child.shadowRoot, depth + 1);
      walk(child, depth + 1);
    }
  }

  walk(document.body, 0);

  return {
    frameIndex,
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scroll: {
      x: window.scrollX,
      y: window.scrollY,
      maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    },
    elements,
  };
}

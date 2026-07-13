// dom-utils.js — shadow-DOM-aware element operations injected into target tab.
//
// Declared as a classic global via importScripts('dom-utils.js') in
// background.js. chrome.scripting.executeScript serializes the function body
// via Function.prototype.toString() and runs it in the target's isolated
// world, so this function must be entirely self-contained: no closures, no
// module imports, no references to anything outside its own body.
//
// Why this exists: observer.js stamps data-bb-id on elements inside open
// shadow roots, and pages like LinkedIn render UI (the post composer) inside
// same-origin iframes — both invisible to a plain document.querySelector in
// the top frame. Lookup here pierces open shadow roots; frame coverage comes
// from background.js injecting this function into all frames and picking the
// frame that finds the element.

function browserBridgeElementOp(opts) {
  const op = opts.op;
  const selector = opts.selector;

  // querySelector that pierces open shadow roots. Light DOM first (fast
  // path), then a breadth-first walk across every open shadow root. Closed
  // shadow roots are unreachable by design.
  function deepQuery(sel) {
    let el = document.querySelector(sel);
    if (el) return el;
    const roots = [document];
    while (roots.length) {
      const root = roots.shift();
      if (root !== document) {
        el = root.querySelector(sel);
        if (el) return el;
      }
      for (const host of root.querySelectorAll("*")) {
        if (host.shadowRoot) roots.push(host.shadowRoot);
      }
    }
    return null;
  }

  function find(sel) {
    let el;
    try {
      el = deepQuery(sel);
    } catch (e) {
      return { err: `Invalid selector: ${sel} (${e && (e.message || String(e))})` };
    }
    if (!el) return { err: `Element not found: ${sel}` };
    return { el };
  }

  // Offset of this frame's viewport within the root viewport, accumulated
  // through same-origin ancestor iframes. Throws on cross-origin ancestors.
  function frameOffset() {
    let win = window, ox = 0, oy = 0;
    while (win.frameElement) {
      const rect = win.frameElement.getBoundingClientRect();
      ox += rect.left + (win.frameElement.clientLeft || 0);
      oy += rect.top + (win.frameElement.clientTop || 0);
      win = win.parent;
    }
    return { ox, oy };
  }

  switch (op) {
    case "exists": {
      const { err } = find(selector);
      if (err) return { __err: err };
      return { found: true };
    }

    case "center": {
      const { el, err } = find(selector);
      if (err) return { __err: err };
      el.scrollIntoView({ block: "center" });
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return { __err: `Element has zero size (hidden or collapsed): ${selector}` };
      }
      // CDP mouse events use root-viewport coordinates — translate through
      // ancestor iframes.
      let off;
      try {
        off = frameOffset();
      } catch {
        return { __err: `Element is inside a cross-origin frame; cannot compute click coordinates: ${selector}` };
      }
      return {
        x: Math.round(rect.left + rect.width / 2 + off.ox),
        y: Math.round(rect.top + rect.height / 2 + off.oy),
      };
    }

    case "focus": {
      const { el, err } = find(selector);
      if (err) return { __err: err };
      el.focus();
      if (opts.clear) {
        if (el.isContentEditable) {
          // `value = ""` is meaningless on contenteditable; select the
          // contents and delete so CDP keystrokes start from an empty editor.
          try {
            const range = document.createRange();
            range.selectNodeContents(el);
            const rootNode = el.getRootNode();
            const sel = rootNode.getSelection ? rootNode.getSelection() : document.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand("delete");
          } catch {
            // Best effort — typing will append instead of replace.
          }
        } else {
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      return { ok: true };
    }

    case "info": {
      const { el, err } = find(selector);
      if (err) return { __err: err };
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
    }

    case "scroll": {
      const o = { left: opts.x || 0, top: opts.y || 0, behavior: opts.behavior || "instant" };
      if (selector) {
        const { el, err } = find(selector);
        if (err) return { __err: err };
        el.scrollBy(o);
      } else {
        window.scrollBy(o);
      }
      return { scrolled: { x: o.left, y: o.top }, selector: selector || "window" };
    }

    case "fill_one": {
      const { el, err } = find(selector);
      if (err) return { __err: err };
      el.focus();
      el.value = opts.value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: opts.value, inputType: "insertText" }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    default:
      return { __err: `Unknown element op: ${op}` };
  }
}

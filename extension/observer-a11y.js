// observer-a11y.js — semantic accessibility-tree walker injected into target tab.
//
// Like observer.js but produces a hierarchical tree of landmark + interactive
// nodes (skipping generic containers), with `text_only` capturing non-interactive
// surrounding text. Stamps stable `data-bb-id` refs that survive across calls,
// so click/type can chain without re-snapshotting.
//
// Must be entirely self-contained — chrome.scripting.executeScript serializes
// via Function.prototype.toString().

function browserBridgeObserveA11y(opts) {
  opts = opts || {};
  const frameIndex = opts.frameIndex != null ? opts.frameIndex : 0;
  const viewportOnly = !!opts.viewportOnly;
  const maxDepth = opts.maxDepth != null ? opts.maxDepth : 60;

  const BB_ATTR = "data-bb-id";
  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "meta", "link", "template", "head", "svg",
  ]);
  const INTERACTIVE_TAGS = new Set([
    "button", "input", "select", "textarea", "a",
    "details", "summary", "option",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "radio", "checkbox", "tab", "textbox", "combobox",
    "slider", "spinbutton", "searchbox", "switch",
  ]);
  const LANDMARK_TAGS = new Set([
    "main", "nav", "header", "footer", "aside", "article", "section", "form",
    "dialog",
  ]);
  const LANDMARK_ROLES = new Set([
    "main", "navigation", "banner", "contentinfo", "complementary",
    "article", "region", "form", "dialog", "alertdialog", "search",
  ]);
  const STRUCTURAL_TAGS = new Set([
    "ul", "ol", "li", "table", "tr", "td", "th", "thead", "tbody",
    "h1", "h2", "h3", "h4", "h5", "h6",
  ]);
  // Roles that add no semantic value — collapse them (promote children).
  const GENERIC_ROLES = new Set([
    "generic", "none", "presentation", "group", "paragraph",
  ]);
  const EVENT_ATTRS = [
    "onclick", "onmousedown", "onmouseup", "onkeydown", "onkeyup",
  ];

  // input type → role
  const INPUT_ROLES = {
    button: "button", submit: "button", reset: "button", image: "button",
    checkbox: "checkbox", radio: "radio", range: "slider",
    search: "searchbox",
    // text-ish defaults
    text: "textbox", email: "textbox", url: "textbox", tel: "textbox",
    password: "textbox", number: "spinbutton", date: "textbox",
    "datetime-local": "textbox", month: "textbox", week: "textbox",
    time: "textbox",
  };

  // tag → implicit role
  const IMPLICIT_ROLES = {
    a: "link", button: "button", select: "combobox", textarea: "textbox",
    nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
    aside: "complementary", article: "article", section: "region",
    form: "form", dialog: "dialog",
    ul: "list", ol: "list", li: "listitem",
    table: "table", tr: "row", td: "cell", th: "columnheader",
    thead: "rowgroup", tbody: "rowgroup",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading",
    h5: "heading", h6: "heading",
    img: "img", summary: "button", details: "group",
  };

  function computeRole(el, tag) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLES[t] || "textbox";
    }
    return IMPLICIT_ROLES[tag] || null;
  }

  function headingLevel(el, tag) {
    if (tag && /^h[1-6]$/.test(tag)) return +tag[1];
    const aria = el.getAttribute("aria-level");
    if (aria) {
      const n = parseInt(aria, 10);
      if (!isNaN(n)) return n;
    }
    return null;
  }

  function isInteractive(el, tag, role) {
    if (INTERACTIVE_TAGS.has(tag)) {
      if (tag === "a" && !el.hasAttribute("href")) return false;
      return true;
    }
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    for (const attr of EVENT_ATTRS) {
      if (el.hasAttribute(attr)) return true;
    }
    if (el.hasAttribute("tabindex")) {
      const ti = parseInt(el.getAttribute("tabindex"), 10);
      if (!isNaN(ti) && ti >= 0) return true;
    }
    return false;
  }

  function isLandmark(tag, role) {
    if (LANDMARK_TAGS.has(tag)) return true;
    if (role && LANDMARK_ROLES.has(role)) return true;
    return false;
  }

  function isStructural(tag) {
    return STRUCTURAL_TAGS.has(tag);
  }

  function isVisible(el, rect) {
    if (el.tagName === "INPUT" && el.type === "file") return true;
    if (el.getAttribute("aria-hidden") === "true") return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      if (parseFloat(cs.opacity) === 0) return false;
    } catch {
      return false;
    }
    if (rect.width < 0 || rect.height < 0) return false;
    return true;
  }

  function inViewport(rect) {
    return rect.top < window.innerHeight && rect.bottom > 0
        && rect.left < window.innerWidth && rect.right > 0;
  }

  function accessibleName(el, tag) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim().slice(0, 200);

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = [];
      for (const id of labelledBy.split(/\s+/)) {
        const ref = document.getElementById(id);
        if (ref) parts.push((ref.innerText || ref.textContent || "").trim());
      }
      const joined = parts.join(" ").trim();
      if (joined) return joined.slice(0, 200);
    }

    if (tag === "input" || tag === "select" || tag === "textarea") {
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) {
          const t = (label.innerText || label.textContent || "").trim();
          if (t) return t.slice(0, 200);
        }
      }
      const wrapping = el.closest("label");
      if (wrapping) {
        const t = (wrapping.innerText || wrapping.textContent || "").trim();
        if (t) return t.slice(0, 200);
      }
      const ph = el.getAttribute("placeholder");
      if (ph) return ph.trim().slice(0, 200);
    }

    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt != null) return alt.trim().slice(0, 200);
    }

    const title = el.getAttribute("title");
    if (title) return title.trim().slice(0, 200);

    // For buttons/links/headings, use visible text.
    if (tag === "button" || tag === "a" || /^h[1-6]$/.test(tag) ||
        tag === "summary" || tag === "option") {
      const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      if (t) return t.slice(0, 200);
    }

    return "";
  }

  function strippedValue(el, tag) {
    if (tag === "input" || tag === "textarea") {
      const v = el.value;
      if (typeof v === "string" && v) return v.slice(0, 120);
    }
    if (tag === "select") {
      const opt = el.options[el.selectedIndex];
      if (opt) return (opt.text || opt.value || "").slice(0, 120);
    }
    return null;
  }

  function ariaState(el) {
    const state = {};
    const checked = el.getAttribute("aria-checked");
    if (checked != null) state.checked = checked;
    const expanded = el.getAttribute("aria-expanded");
    if (expanded != null) state.expanded = expanded === "true";
    const pressed = el.getAttribute("aria-pressed");
    if (pressed != null) state.pressed = pressed;
    const selected = el.getAttribute("aria-selected");
    if (selected != null) state.selected = selected === "true";
    const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
    if (disabled) state.disabled = true;
    const required = el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
    if (required) state.required = true;
    if (el.tagName === "INPUT" && el.type === "checkbox" && state.checked == null) {
      state.checked = el.checked ? "true" : "false";
    }
    return Object.keys(state).length ? state : null;
  }

  // Establish next free index per frame, preserving existing bb-ids for stability.
  let nextIdx = 0;
  for (const el of document.querySelectorAll(`[${BB_ATTR}]`)) {
    const id = el.getAttribute(BB_ATTR);
    const m = /^(\d+)-(\d+)$/.exec(id);
    if (m && +m[1] === frameIndex) {
      const n = +m[2];
      if (n >= nextIdx) nextIdx = n + 1;
    }
  }

  function stampId(el) {
    let id = el.getAttribute(BB_ATTR);
    if (id && /^\d+-\d+$/.test(id)) return id;
    id = `${frameIndex}-${nextIdx++}`;
    el.setAttribute(BB_ATTR, id);
    return id;
  }

  // Collect "own text" for a kept entry: visible text in its subtree that is
  // NOT inside any descendant which is itself a kept entry. We mark kept
  // elements during the walk so this can use a TreeWalker afterward.
  // To avoid a second pass, we collect inline during the walk: maintain a
  // running text buffer per entry, pushing text nodes encountered before
  // descending into a kept child, and resuming after.
  //
  // Simpler approach: after the walk, for each kept entry, run a TreeWalker
  // that rejects text descended through any element marked with KEPT_ATTR.
  const KEPT_ATTR = "data-bb-kept";

  const root = { id: null, role: "root", children: [] };
  const stack = [root];

  function pushEntry(el, tag, role) {
    const id = stampId(el);
    el.setAttribute(KEPT_ATTR, "1");
    const entry = { id, tag, role: role || tag };
    const name = accessibleName(el, tag);
    if (name) entry.name = name;
    const h = headingLevel(el, tag);
    if (h != null) entry.level = h;
    const type = el.getAttribute("type");
    if (type && tag === "input") entry.input_type = type;
    const val = strippedValue(el, tag);
    if (val != null) entry.value = val;
    if (tag === "a" && el.href) entry.href = el.href;
    const state = ariaState(el);
    if (state) entry.state = state;
    entry.children = [];
    return entry;
  }

  function walk(el, depth) {
    if (depth > maxDepth) return;
    const children = el.children;
    if (!children || !children.length) return;
    for (const child of children) {
      if (!(child instanceof Element)) continue;
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;

      const rect = child.getBoundingClientRect();
      const visible = isVisible(child, rect);
      const inView = visible && inViewport(rect);
      const role = computeRole(child, tag);
      const interactive = isInteractive(child, tag, role);
      const landmark = isLandmark(tag, role);
      const structural = isStructural(tag);
      const generic = role && GENERIC_ROLES.has(role);
      const isImg = tag === "img" && child.getAttribute("alt") !== "";

      const keep = visible
        && !generic
        && (interactive || landmark || structural || isImg ||
            (role && role !== "text"))
        && (!viewportOnly || inView || landmark || structural);

      let pushed = false;
      if (keep) {
        const entry = pushEntry(child, tag, role);
        if (!viewportOnly) entry.in_viewport = inView;
        stack[stack.length - 1].children.push(entry);
        stack.push(entry);
        pushed = true;
      }

      if (child.shadowRoot) walk(child.shadowRoot, depth + 1);
      walk(child, depth + 1);

      if (pushed) stack.pop();
    }
  }

  // Clear stale KEPT markers from prior runs.
  for (const el of document.querySelectorAll(`[${KEPT_ATTR}]`)) {
    el.removeAttribute(KEPT_ATTR);
  }

  walk(document.body, 0);

  // Compute text_only for each kept entry, after the tree is marked.
  function attachText(entry, el) {
    if (!el) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentElement;
        while (p && p !== el) {
          if (p.hasAttribute(KEPT_ATTR)) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const parts = [];
    let node;
    let len = 0;
    while ((node = walker.nextNode())) {
      const t = node.textContent.replace(/\s+/g, " ").trim();
      if (!t) continue;
      parts.push(t);
      len += t.length;
      if (len > 400) break;
    }
    const joined = parts.join(" ").trim();
    if (joined) {
      // Skip if text_only is just the accessibleName again (common for buttons).
      if (!entry.name || joined !== entry.name) {
        entry.text_only = joined.slice(0, 400);
      }
    }
    for (const c of entry.children) {
      const childEl = document.querySelector(`[${BB_ATTR}="${c.id}"]`);
      attachText(c, childEl);
    }
  }
  for (const top of root.children) {
    const el = document.querySelector(`[${BB_ATTR}="${top.id}"]`);
    attachText(top, el);
  }

  // Clear KEPT markers (bb-ids stay — those are stable refs).
  for (const el of document.querySelectorAll(`[${KEPT_ATTR}]`)) {
    el.removeAttribute(KEPT_ATTR);
  }

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
    tree: root.children,
  };
}

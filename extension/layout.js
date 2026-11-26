// React owns row identities, content and event handlers. CSS on mounted cells
// lets its ResizeObserver see removals and preserves those identities on undo.
const feedLayout = (() => {
  const cell = '[data-testid="cellInnerDiv"],[data-item-index],[data-index],[role="listitem"]';
  const groupMark = "data-mox-compact";
  const virtualWindow = "data-mox-window";
  const hide = "data-mox-hide";
  const gap = "data-mox-spacer";
  const groups = new Set();
  const marked = new Set();
  const ordered = new Set();
  const hiddenHeights = new WeakMap();
  const windows = new WeakMap();
  let priorPosts = new WeakMap();

  // Remember compacted coordinates for recently mounted boundaries. Derive
  // hidden spans from adjacent native offsets: a row X remeasured at zero
  // has no space left to subtract when it scrolls out of the window.
  function leadingPadding(group, offsets, rows, hidden) {
    const recent = windows.get(group) || new Map();
    const first = offsets.get(rows[0]);
    let removed = recent.get(first) || 0;
    const leading = Math.max(0, first - removed);
    for (let i = 0; i < rows.length; i++) {
      const y = offsets.get(rows[i]);
      recent.delete(y);
      recent.set(y, removed);
      if (hidden.has(rows[i]) && i + 1 < rows.length) removed += offsets.get(rows[i + 1]) - y;
    }
    const limit = Math.max(512, rows.length);
    while (recent.size > limit) recent.delete(recent.keys().next().value);
    windows.set(group, recent);
    return leading;
  }
  const stylesheet = `
    [${hide}]{display:none!important}
    [${virtualWindow}]{overflow-anchor:none!important}
    [${groupMark}]{--mox-window-start:0px;--mox-window-end:0px;display:flex!important;flex-direction:column!important;gap:0!important;height:auto!important;min-height:0!important;padding-block:var(--mox-window-start) var(--mox-window-end)!important}
    [${groupMark}] > *{position:relative!important;inset:auto!important;transform:none!important;translate:none!important;order:var(--mox-row-order,2147483647)!important;flex:none!important}
    [${groupMark}] > [${gap}]{height:0!important;min-height:0!important;padding:0!important;margin:0!important;border:0!important}
  `;
  function rowFor(post) {
    let row = post.closest(cell);
    if (!row || row.querySelectorAll("article:not(article article)").length !== 1) row = post;
    const parent = row.parentElement;
    if (row === post && parent && !parent.matches("body,main,section,[role=main]")) {
      const overlay = parent.children.length === 2 && parent.querySelector(':scope > a[href*="/status/"]');
      const sibling = parent.previousElementSibling || parent.nextElementSibling;
      const repeated = parent.childElementCount === 1 && sibling?.tagName === parent.tagName && sibling.querySelector("article");
      const permalink = parent.childElementCount === 1 && parent.matches('[role="link"][data-href*="/status/"]');
      if (overlay || repeated || permalink) row = parent;
    }
    // Some virtualizers put the translated slot outside the semantic cell.
    for (let slot = row; slot && !slot.matches("main,section,body,[role=main]"); slot = slot.parentElement) {
      if (slot !== row && slot.querySelectorAll("article:not(article article)").length !== 1) break;
      if (slot.parentElement?.hasAttribute(groupMark) || slot.style.transform || slot.style.translate ||
          getComputedStyle(slot).position === "absolute") return slot;
      if (slot.parentElement?.children.length > 1) break;
    }
    return row;
  }
  function scrollerFor(row) {
    for (let parent = row.parentElement; parent && parent !== document.body; parent = parent.parentElement)
      if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) return parent;
    return document.scrollingElement;
  }

  function postLink(post) {
    return post.parentElement?.dataset.href || post.querySelector('a[href*="/status/"]')?.getAttribute("href");
  }

  // A virtualizer changes the DOM before our observer runs. Use the last
  // committed list-relative position so the user's intervening scroll counts.
  // For ordinary flow we can measure immediately before removing a row.
  function captureReadingPositions(decisions, hidden, revealing, active, preservePosition) {
    const viewports = new Map(), previousGroups = new Map();
    function track(scroller, removalTop = -Infinity) {
      if (!scroller?.scrollTop || viewports.has(scroller)) return;
      const bounds = scroller === document.scrollingElement ? {top:0, bottom:innerHeight} : scroller.getBoundingClientRect();
      const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
      const middle = (top + bottom) / 2;
      if (bottom > top && removalTop <= middle) viewports.set(scroller, {top, bottom, middle, distance:Infinity});
    }
    for (const group of active) {
      if (!windows.has(group)) continue;
      const scroller = scrollerFor(group);
      track(scroller);
      previousGroups.set(group, {top:group.getBoundingClientRect().top, scroller});
    }
    for (const row of revealing) track(scrollerFor(row));
    if (preservePosition) {
      for (const row of hidden) {
        if (marked.has(row)) continue;
        const rect = row.getBoundingClientRect();
        if (rect.height) track(scrollerFor(row), rect.top);
      }
    }
    if (!viewports.size) return viewports;
    for (const [post, excluded] of decisions) {
      if (excluded) continue;
      const previous = priorPosts.get(post);
      const group = previous && previousGroups.get(previous.group);
      if (group && (!previous.group.contains(post) || previous.link !== postLink(post))) continue;
      const rect = post.getBoundingClientRect();
      if (!rect.height) continue;
      const expected = group ? group.top + previous.offset : rect.top;
      if (expected + rect.height <= 0 || expected >= innerHeight) continue;
      const viewport = viewports.get(group?.scroller || scrollerFor(post));
      if (!viewport || expected + rect.height <= viewport.top || expected >= viewport.bottom) continue;
      const distance = Math.abs(expected - viewport.middle);
      if (distance < viewport.distance) {
        viewport.distance = distance;
        viewport.post = post;
        viewport.before = expected;
      }
    }
    return viewports;
  }
  function apply(decisions, preservePosition) {
    const hidden = new Set();
    const revealing = new Set();
    const active = new Set();
    const slots = new Set();
    for (const [post, exclude] of decisions) {
      const row = rowFor(post);
      if (exclude) hidden.add(row);
      else if (row.hasAttribute(hide)) {
        marked.add(row);
        revealing.add(row);
      }
      if (row.matches(cell) || row.style.transform || row.style.translate || row.parentElement?.hasAttribute(groupMark) ||
          getComputedStyle(row).position === "absolute") {
        slots.add(row);
        if (exclude || groups.has(row.parentElement)) active.add(row.parentElement);
      }
    }
    const anchors = captureReadingPositions(decisions, hidden, revealing, active, preservePosition);
    // Drop stale marks on detached/recycled nodes as well as visible ones.
    for (const row of marked) if (!hidden.has(row)) { row.removeAttribute(hide); marked.delete(row); }
    for (const row of hidden) {
      if (!row.hasAttribute(hide)) {
        hiddenHeights.set(row, row.getBoundingClientRect().height);
        row.setAttribute(hide, "");
      }
      marked.add(row);
    }
    for (const group of groups) {
      if (!active.has(group)) {
        group.removeAttribute(groupMark);
        group.removeAttribute(virtualWindow);
        group.style.removeProperty("--mox-window-start");
        group.style.removeProperty("--mox-window-end");
        windows.delete(group);
        groups.delete(group);
      }
    }
    const current = new Set();
    for (const group of active) {
      if (group.matches("body,main,[role=main]")) continue;
      groups.add(group);
      const children = [...group.children];
      // A recycler can keep DOM order while reassigning translated Y slots.
      const position = el => {
        try {
          const translate = el.style.translate.trim().split(/\s+/);
          return new DOMMatrixReadOnly(el.style.transform || undefined).m42 +
            (parseFloat(translate[1]) || 0) + (parseFloat(el.style.top) || 0);
        }
        catch { return 0; }
      };
      const positionedRow = node => node.style.transform || node.style.translate || parseFloat(node.style.top) || node.style.position === "absolute";
      const positioned = children.some(node => slots.has(node) && positionedRow(node));
      // A loader can have the same cell test ID as a post but no Y position.
      const isSlot = node => (slots.has(node) || node.matches(cell)) && (!positioned || positionedRow(node));
      const rows = children.filter(isSlot);
      const offsets = new Map(rows.map(row => [row, position(row)]));
      const sorted = rows.sort((a,b) => offsets.get(a) - offsets.get(b));
      // The virtualizer may mount only a middle slice. Keep the space before
      // and after that slice while letting flex close gaps between its rows.
      const last = sorted.at(-1);
      const px = value => /^\d+(?:\.\d+)?px$/.test(value) ? parseFloat(value) : 0;
      const extent = Math.max(px(group.style.minHeight), px(group.style.height));
      let start = 0, end = 0;
      if (positioned) {
        start = leadingPadding(group, offsets, sorted, hidden);
        if (extent) {
          const height = hidden.has(last) ? hiddenHeights.get(last) : last.getBoundingClientRect().height;
          if (height !== undefined) end = Math.max(0, extent - offsets.get(last) - height);
        }
      } else {
        windows.delete(group);
      }
      for (const [property, size] of [["--mox-window-start",start], ["--mox-window-end",end]]) {
        const value = size ? size + "px" : "";
        if (group.style.getPropertyValue(property) !== value) group.style.setProperty(property, value);
      }
      // Apply the new layout only after its full scroll range is defined.
      // An intervening measurement could otherwise clamp a deep scroll offset.
      group.toggleAttribute(virtualWindow, positioned);
      group.toggleAttribute(groupMark, true);
      let index = 0;
      children.forEach((node, slot) => {
        const item = isSlot(node) ? sorted[index++] : node;
        current.add(item);
        const spacing = positioned && !isSlot(item) && !item.childElementCount && !item.textContent.trim() &&
          (item.getAttribute("aria-hidden") === "true" || item.style.height || item.style.minHeight);
        item.toggleAttribute(gap, Boolean(spacing));
        if (item.style.getPropertyValue("--mox-row-order") !== String(slot)) item.style.setProperty("--mox-row-order", String(slot));
        ordered.add(item);
      });
    }
    for (const item of ordered) {
      if (!current.has(item)) {
        item.style.removeProperty("--mox-row-order");
        item.removeAttribute(gap);
        ordered.delete(item);
      }
    }
    priorPosts = new WeakMap();
    const tops = new Map();
    for (const [post, excluded] of decisions) {
      if (excluded) continue;
      const group = post.closest("[" + groupMark + "]");
      if (!windows.has(group)) continue;
      if (!tops.has(group)) tops.set(group, group.getBoundingClientRect().top);
      priorPosts.set(post, {group, link:postLink(post), offset:post.getBoundingClientRect().top - tops.get(group)});
    }
    for (const [scroller, anchor] of anchors) {
      if (!anchor.post) continue;
      const movement = anchor.post.getBoundingClientRect().top - anchor.before;
      if (Math.abs(movement) >= 1) scroller.scrollBy({top: movement, behavior: "instant"});
    }
  }
  return { apply, stylesheet };
})();

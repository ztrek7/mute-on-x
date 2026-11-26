(() => {
  let capture;
  let notice;
  let noticeTimer;
  const messages = [];
  const sourceDocument = crypto.randomUUID();
  const words = new Intl.Segmenter(undefined, { granularity: "word" });
  const containsPoint = (rect, x, y) =>
    x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;

  function wordAt(event) {
    const { clientX: x, clientY: y } = event;
    const caret = document.caretPositionFromPoint(x, y);
    const node = caret?.offsetNode;
    if (node?.nodeType !== Node.TEXT_NODE || !event.target.contains(node)) return "";
    const segments = words.segment(node.data);
    // The caret can land on either side of the character under the pointer.
    for (const offset of [caret.offset, caret.offset - 1, caret.offset + 1]) {
      const part = segments.containing(offset);
      if (!part?.isWordLike) continue;
      let start = part.index;
      if (start && /[#@]/u.test(node.data[start - 1])) start--;
      const end = part.index + part.segment.length;
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, end);
      if ([...range.getClientRects()].some(rect => containsPoint(rect, x, y))) {
        return node.data.slice(start, end);
      }
    }
    return "";
  }

  window.addEventListener("contextmenu", event => {
    if (!event.isTrusted) return;
    capture = null;
    const el = event.target;
    if (!(el instanceof Element) || el.closest('input[type="password"]')) return;
    let selected = "";
    let word = "";
    const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    if (field) {
      selected = el.value.slice(el.selectionStart, el.selectionEnd);
    } else {
      const selection = getSelection();
      if (selection?.rangeCount && !selection.isCollapsed) {
        const rects = selection.getRangeAt(0).getClientRects();
        if ([...rects].some(rect => containsPoint(rect, event.clientX, event.clientY))) {
          selected = selection.toString();
        }
      }
      word = wordAt(event);
    }
    capture = { selected, field, word, url: location.href, time: performance.now() };
  }, true);
  window.addEventListener("pagehide", () => { capture = null; });

  function dismissNotice() {
    clearTimeout(noticeTimer);
    notice?.remove();
    notice = null;
    showNext();
  }

  function showNext() {
    if (notice || document.hidden) return;
    while (messages.length && messages[0].pageUrl !== location.href) messages.shift();
    const message = messages.shift();
    if (!message) return;
    notice = document.createElement("aside");
    notice.style.cssText = "all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647";
    const root = notice.attachShadow({ mode: "closed" });
    const box = document.createElement("div");
    box.style.cssText = "display:flex;align-items:center;gap:12px;max-width:min(380px,84vw);padding:12px 16px;background:#17232d;color:white;border:1px solid #8899a6;border-radius:10px;font:15px/1.4 system-ui;overflow-wrap:anywhere";
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    status.textContent = message.text;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Close";
    dismiss.addEventListener("click", dismissNotice);
    box.append(status, dismiss);
    root.append(box);
    document.documentElement.append(notice);
    noticeTimer = setTimeout(dismissNotice, message.error ? 15_000 : 6000);
  }

  document.addEventListener("visibilitychange", showNext);

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === "notice") {
      if (message.pageUrl !== location.href || message.sourceDocument !== sourceDocument) return;
      messages.push(message);
      showNext();
      respond(true);
    }
    if (message.type !== "capture") return;
    const last = capture;
    capture = null;
    let term = "";
    if (last && last.url === location.href && last.url === message.pageUrl &&
        performance.now() - last.time <= 60_000) {
      // Ignore a selection elsewhere on the page, even if Chromium reports it.
      // A form field also requires the browser to confirm its selected text.
      const selection = last.selected.trim();
      const singleLine = text => text.trim().replace(/\s+/gu, " ");
      const native = message.selectionText?.trim();
      if (!selection) term = last.word;
      else if (native ? singleLine(native) === singleLine(selection) : !last.field) {
        term = selection.replace(/[\r\n]+/gu, " ");
      }
    }
    respond({ term, sourceDocument });
  });
})();

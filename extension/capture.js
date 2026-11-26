(() => {
  let capture;
  let notice;
  let noticeTimer;
  const messages = [];
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
    dismiss.style.cssText = "flex:none;white-space:nowrap";
    dismiss.addEventListener("click", dismissNotice);
    box.append(status, dismiss);
    root.append(box);
    document.documentElement.append(notice);
    noticeTimer = setTimeout(dismissNotice, message.error ? 15_000 : 6000);
  }

  document.addEventListener("visibilitychange", showNext);

  function formNotice(text) {
    messages.push({text, pageUrl: location.href});
    showNext();
  }

  if (window === window.top && location.href === "https://x.com/settings/add_muted_keyword") {
    void chrome.runtime.sendMessage({type: "native-mute-prefill"}).then(term => {
      if (typeof term !== "string" || !term) return;
      // X hydrates the native form after navigation. Only fill an empty, editable field.
      // All choices and the final Save remain under the user's control.
      const path = location.href;
      const stop = () => { observer.disconnect(); clearTimeout(timeout); };
      function fill() {
        if (location.href !== path) { stop(); return; }
        const fields = [...document.querySelectorAll('input[name="keyword"]')]
          .filter(el => el.type === "text" && el.checkVisibility() && !el.disabled && !el.readOnly);
        if (fields.length !== 1) return;
        const field = fields[0];
        stop();
        if (field.value || (field.maxLength >= 0 && term.length > field.maxLength)) {
          formNotice("Review the word and settings, then choose Save in X.");
          return;
        }
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, term);
        field.dispatchEvent(new Event("input", {bubbles:true}));
        formNotice("Review the word and settings, then choose Save in X.");
      }
      const observer = new MutationObserver(fill);
      const timeout = setTimeout(() => {
        stop();
        if (location.href === path) formNotice("Enter “" + term + "” in X’s muted-word form and choose Save.");
      }, 12_000);
      observer.observe(document, {subtree:true, childList:true, attributes:true,
        attributeFilter:["name","type","hidden","style","class","disabled","readonly"]});
      window.addEventListener("pagehide", stop, {once:true});
      fill();
    }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === "native-form-error" && sender.id === chrome.runtime.id && message.pageUrl === location.href) {
      formNotice("Couldn’t open X’s Add muted word form. You can add the word from X’s muted-word settings.");
      return;
    }
    if (message.type !== "mute-selection" || sender.id !== chrome.runtime.id ||
        window !== window.top || location.origin !== "https://x.com" || message.pageUrl !== location.href) return;
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
    const display = (text, error = false) => {
      if (message.pageUrl !== location.href) return;
      messages.push({text, error, pageUrl: message.pageUrl});
      showNext();
    };
    if (!term) {
      display("Right-click directly on a word or a selected phrase, then choose Mute on X again.", true);
      respond(true);
      return;
    }
    saveMutedWord(term, message.pageUrl).then(text => {
      display(text);
      respond(true);
    }, error => {
      if (error === nativeMuteFormNeeded && location.href === message.pageUrl) {
        display("Finish muting in X’s Add muted word form. Review the settings and choose Save.");
        respond({nativeTerm: term});
      } else {
        display(error.message || "The X page changed. Choose Mute on X again.", true);
        respond(true);
      }
    });
    return true;
  });
})();

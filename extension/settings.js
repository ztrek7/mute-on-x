(() => {
  const list = "/settings/muted_keywords";
  const add = "/settings/add_muted_keyword";
  const documentId = crypto.randomUUID();
  const visible = el => el?.checkVisibility({ visibilityProperty: true }) && el.getClientRects().length;
  const unique = selector => {
    const candidates = [...document.querySelectorAll(selector)].filter(visible);
    return candidates.length === 1 ? candidates[0] : null;
  };
  const enabled = el => visible(el) && !el.matches(':disabled, [aria-disabled="true"]');
  const fold = text => text.trim().normalize("NFC").toLowerCase();

  // Compare alerts across inspections without forwarding page-authored text.
  let lastAlertText = "", alertVersion = 0;
  function currentAlertVersion() {
    const alert = [...document.querySelectorAll('[role="alert"], [data-testid="toast"]')]
      .find(el => visible(el) && el.innerText.trim());
    const text = alert?.innerText.trim().slice(0, 250) || "";
    if (text !== lastAlertText) {
      lastAlertText = text;
      alertVersion++;
    }
    return text ? alertVersion : 0;
  }

  function listed(term, link) {
    // The first line of a muted-word edit row is its keyword. Later lines
    // are metadata such as duration. Ignore navigation links and page text.
    const detail = link?.closest("section") || unique('main section[aria-label="Section details"]') ||
      unique('[data-testid="primaryColumn"] section');
    if (!detail) return false;
    const rows = detail.querySelectorAll('[role="link"], a[href]');
    return [...rows].some(row => visible(row) && row.querySelector('button, [role="button"]') &&
      fold(row.innerText.trim().split("\n")[0]) === fold(term));
  }

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type !== "settings") return;
    const path = location.pathname;
    const result = { documentId, path };
    if (/^\/(?:login|i\/flow\/login|i\/jf\/onboarding)(?:\/|$)/.test(path) ||
        visible(document.querySelector('input[autocomplete="current-password"]'))) {
      respond({ ...result, error: "Sign in to X, then right-click the word again." });
      return;
    }

    const link = path === list && unique('a[href="/settings/add_muted_keyword"]');
    const field = path === add && unique('input[name="keyword"]');
    const save = path === add && unique('[data-testid="settingsDetailSave"]');
    if (msg.action === "inspect") {
      result.listReady = Boolean(link && ![...document.querySelectorAll('section [role="progressbar"]')].some(visible));
      result.listed = path === list && listed(msg.term, link);
      result.formReady = Boolean(field && !field.disabled && !field.readOnly && save);
      result.canSave = Boolean(field && field.value === msg.term && enabled(save));
      if (path === add) result.alert = currentAlertVersion();
      respond(result);
      return;
    }

    let acted = false;
    // Recheck immediately before each mutation, in the same document.
    if (msg.documentId === documentId) {
      if (msg.action === "open" && link && !listed(msg.term, link)) {
        link.click();
        acted = true;
      }
      if (msg.action === "fill" && field && !field.disabled && !field.readOnly &&
          field.value === "" && (field.maxLength < 0 || msg.term.length <= field.maxLength)) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, msg.term);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        acted = true;
      }
      if (msg.action === "save" && field && field.value === msg.term && enabled(save)) {
        save.click();
        acted = true;
      }
    }
    respond({ acted });
  });
})();

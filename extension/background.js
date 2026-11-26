const menuId = "mute-on-x";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: menuId, title: "Mute on X", contexts: ["page", "link", "selection", "editable"],
    documentUrlPatterns: ["https://x.com/*"]
  });
});

const nativeFormUrl = "https://x.com/settings/add_muted_keyword";
const nativeFormTerms = new Map();

// Only the result of a browser context-menu action can open a handoff.
// Keep the term out of URLs, storage, history and unrelated X documents.
async function openNativeForm(source, term) {
  const form = await chrome.tabs.create({windowId: source.windowId, active: true, url: "about:blank"});
  const timeout = setTimeout(() => nativeFormTerms.delete(form.id), 30_000);
  nativeFormTerms.set(form.id, {term, timeout});
  try {
    await chrome.tabs.update(form.id, {url: nativeFormUrl});
  } catch (error) {
    clearNativeTerm(form.id);
    throw error;
  }
}

function clearNativeTerm(tabId) {
  const pending = nativeFormTerms.get(tabId);
  if (pending) clearTimeout(pending.timeout);
  nativeFormTerms.delete(tabId);
}

chrome.tabs.onRemoved.addListener(clearNativeTerm);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "native-mute-prefill" || sender.id !== chrome.runtime.id ||
      sender.url !== nativeFormUrl || sender.frameId !== 0 || !sender.tab) return;
  const pending = nativeFormTerms.get(sender.tab.id);
  clearNativeTerm(sender.tab.id);
  respond(pending?.term ?? null);
});

async function handleMenu(info, tab) {
  if (info.menuItemId !== menuId || !Number.isInteger(tab?.id) || (info.frameId ?? 0) !== 0 ||
      !info.pageUrl?.startsWith("https://x.com/")) return;
  // The originating document consumes its own one-use, trusted pointer capture.
  // A closed or replaced tab must never cause a second delivery.
  const result = await chrome.tabs.sendMessage(tab.id, {
    type: "mute-selection", pageUrl: info.pageUrl, selectionText: info.selectionText
  }, {frameId: 0}).catch(() => null);
  if (typeof result?.nativeTerm === "string" && result.nativeTerm.trim() && result.nativeTerm.length <= 140) {
    try {
      await openNativeForm(tab, result.nativeTerm);
    } catch {
      await chrome.tabs.sendMessage(tab.id, {type: "native-form-error", pageUrl: info.pageUrl},
        {frameId: 0}).catch(() => {});
    }
  }
}

chrome.contextMenus.onClicked.addListener(handleMenu);

importScripts("location-cache.js");

importScripts("blocked-stats.js");

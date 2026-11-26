const menuId = "mute-on-x";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: menuId, title: "Mute on X", contexts: ["page", "link", "selection", "editable"],
    documentUrlPatterns: ["https://x.com/*"]
  });
});

async function handleMenu(info, tab) {
  if (info.menuItemId !== menuId || !Number.isInteger(tab?.id) || (info.frameId ?? 0) !== 0 ||
      !info.pageUrl?.startsWith("https://x.com/")) return;
  // The originating document consumes its own one-use, trusted pointer capture.
  // A closed or replaced tab must never cause a second delivery.
  await chrome.tabs.sendMessage(tab.id, {
    type: "mute-selection", pageUrl: info.pageUrl, selectionText: info.selectionText
  }, {frameId: 0}).catch(() => {});
}

chrome.contextMenus.onClicked.addListener(handleMenu);

importScripts("location-cache.js");

importScripts("blocked-stats.js");

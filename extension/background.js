const menuId = "mute-on-x";
const list = "/settings/muted_keywords";
const add = "/settings/add_muted_keyword";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: menuId, title: "Mute on X", contexts: ["page", "link", "selection", "editable"],
    documentUrlPatterns: ["https://x.com/*"]
  });
});

async function send(id, message) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(id, message, { frameId: 0 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("The X tab stopped responding.")), 3000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(helper, term, accept, timeoutMessage) {
  const deadline = Date.now() + 15_000;
  do {
    if (helper.stop) throw new Error(helper.stop);
    // A newly opened or reloading tab may not have a content script yet.
    const state = await send(helper.id, { type: "settings", action: "inspect", term }).catch(() => null);
    if (state?.error) throw new Error(state.error);
    if (state && accept(state)) return state;
    if (state && ![list, add].includes(state.path)) {
      throw new Error("X left the muted-word settings. Check your muted words before trying again.");
    }
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error(timeoutMessage);
}

async function act(helper, term, state, action, failure) {
  if (helper.stop) throw new Error(helper.stop);
  // A lost reply could mean the click already ran. Never replay a mutation.
  const reply = await send(helper.id, { type: "settings", action, term, documentId: state.documentId })
    .catch(() => null);
  if (!reply?.acted) throw new Error(failure);
}

async function mute(helper, term) {
  const inspect = (predicate, failure) => waitFor(helper, term, predicate, failure);
  const start = await inspect(s => s.listReady, "Couldn’t open X’s muted words. Check your sign-in and settings.");
  if (start.listed) return `“${term}” is already in your muted words.`;
  await act(helper, term, start, "open", "The muted-word list changed. Check it before trying again.");
  const form = await inspect(s => s.formReady, "Couldn’t find X’s Add muted word form.");
  await act(helper, term, form, "fill", "Couldn’t enter this text in X’s word field. Try a shorter selection or add it in X settings.");
  const ready = await inspect(s => s.canSave, "X didn’t enable Save for this text. Review it in X’s muted-word settings.");
  await act(helper, term, ready, "save", "Couldn’t confirm the Save click. Check your muted words.");
  const returned = await inspect(s => {
    if (s.alert && s.alert !== ready.alert && s.path === add) {
      throw new Error("X reported a problem saving the word. Check your muted words before trying again.");
    }
    return s.listReady;
  }, "Save unconfirmed. Check your muted words before trying again.");

  // X may render an optimistic row. Require an exact entry in a fresh document.
  if (helper.stop) throw new Error(helper.stop);
  await chrome.tabs.reload(helper.id, { bypassCache: true });
  await inspect(s => s.documentId !== returned.documentId && s.listReady && s.listed,
    `Save unconfirmed. Couldn’t find “${term}” in the reloaded muted-word list.`);
  return `Confirmed “${term}” in your muted words.`;
}

const prefix = "mute:";
const interrupted = "Mute on X was interrupted. Check your muted words before trying again.";
const taken = "You opened or moved the temporary tab. Check your muted words there.";
const running = new Map();
let queue = Promise.resolve();

function notice(job, text, error = false) {
  return send(job.source, {
    type: "notice", text, error, pageUrl: job.pageUrl, sourceDocument: job.sourceDocument
  }).catch(() => false);
}

async function forget(key) {
  await chrome.storage.session.remove(key);
  await chrome.alarms.clear(key);
}

async function finish(key, job, helper, text, error) {
  // IDs are unique within the browser session, which is also the lifetime of
  // the ownership record. Closing an inactive helper preserves the selection.
  if (helper?.id != null && !helper.taken) {
    const tab = await chrome.tabs.get(helper.id).catch(() => null);
    if (tab && !tab.active && !tab.pinned && tab.windowId === job.windowId && !helper.taken) {
      await chrome.tabs.remove(helper.id).catch(async err => {
        if (await chrome.tabs.get(helper.id).catch(() => null)) throw err;
      });
    }
  }
  if (job.kind !== "about") await notice(job, text, error);
  await forget(key);
}

async function run(key, job, helper, term) {
  let text, error = false;
  try {
    const tab = await chrome.tabs.get(helper.id);
    if (helper.stop || tab.active || tab.pinned || tab.windowId !== job.windowId) {
      throw new Error(helper.stop || taken);
    }
    await chrome.tabs.update(helper.id, { url: "https://x.com" + list });
    text = await mute(helper, term);
  } catch (err) {
    text = helper.stop || err.message;
    error = true;
  }
  try {
    await finish(key, job, helper, text, error);
  } finally {
    running.delete(key);
  }
}

// Activation and detachment transfer the tab to the user. Record that handoff
// even if Brave stops the worker before the in-flight operation unwinds.
let startupAdoptions = new Set();
function release(tabId, adopted) {
  if (adopted) startupAdoptions?.add(tabId);
  for (const [key, helper] of running) {
    if (helper.id !== tabId) continue;
    helper.stop = adopted ? taken : interrupted;
    if (adopted) {
      helper.taken = true;
      void forget(key).catch(console.error);
    }
  }
}
chrome.tabs.onActivated.addListener(({ tabId }) => release(tabId, true));
chrome.tabs.onDetached.addListener(tabId => release(tabId, true));
chrome.tabs.onRemoved.addListener(tabId => release(tabId, false));

async function recover(key, job) {
  if (running.has(key)) return;
  const helper = { id: job.helperId };
  running.set(key, helper);
  try {
    if (helper.id == null) {
      // A stop can split tabs.create from recording its returned ID. At this
      // point the request can only own its nonce-tagged private launch page.
      const pages = await chrome.runtime.getContexts({
        contextTypes: ["TAB"], documentUrls: [chrome.runtime.getURL("launch.html?" + key)],
        windowIds: [job.windowId]
      });
      if (pages.length === 1) helper.id = pages[0].tabId;
      // The browser may have accepted create() while its first document is
      // still loading. Leave the alarm armed for a second look.
      if (!pages.length && Date.now() < job.launchDeadline) return;
    }
    helper.taken ||= startupAdoptions?.has(helper.id);
    await finish(key, job, helper, interrupted, true);
  } finally {
    running.delete(key);
  }
}

// An alarm wakes a replacement worker even if X stops responding and every
// other tab is idle. A replacement cleans up; it never repeats the Save click.
const startup = chrome.storage.session.getKeys().then(keys =>
  chrome.storage.session.get(keys.filter(key => key.startsWith(prefix)))
).then(jobs => Promise.all(
  Object.entries(jobs).map(([key, job]) => recover(key, job).catch(console.error))
)).finally(() => { startupAdoptions = null; });

chrome.alarms.onAlarm.addListener(async ({ name: key }) => {
  if (!key.startsWith(prefix)) return;
  await startup;
  if (running.has(key)) return;
  const job = (await chrome.storage.session.get(key))[key];
  if (job) await recover(key, job);
  else await chrome.alarms.clear(key);
});

async function createOwned(key, job, helper) {
  job.launchDeadline = Date.now() + 60_000;
  await chrome.alarms.create(key, { periodInMinutes: 0.5 });
  await chrome.storage.session.set({ [key]: job });
  const created = await chrome.tabs.create({
    active: false, windowId: job.windowId, openerTabId: job.source,
    url: chrome.runtime.getURL("launch.html?" + key)
  });
  helper.id = created.id;
  // Persist the browser-issued ID before navigating or mutating anything.
  job.helperId = created.id;
  await chrome.storage.session.set({ [key]: job });
}

async function handleMenu(info, tab) {
  if (info.menuItemId !== menuId || !Number.isInteger(tab?.id) || (info.frameId ?? 0) !== 0 ||
      !info.pageUrl?.startsWith("https://x.com/")) return;
  await startup;
  const key = prefix + crypto.randomUUID();
  const job = { source: tab.id, windowId: tab.windowId, pageUrl: info.pageUrl };
  const helper = { id: null, taken: false, stop: "" };
  running.set(key, helper);
  try {
    const capture = await send(tab.id, {
      type: "capture", pageUrl: info.pageUrl, selectionText: info.selectionText
    });
    job.sourceDocument = capture?.sourceDocument;
    if (!capture?.term) throw new Error("Right-click directly on a word or a selected phrase, then choose Mute on X again.");
    await createOwned(key, job, helper);
    // One writer at a time, so repeated words see the previous verified save.
    queue = queue.then(() => run(key, job, helper, capture.term)).catch(console.error);
  } catch (error) {
    try {
      await finish(key, job, helper, error.message, true);
    } finally {
      running.delete(key);
    }
  }
}

chrome.contextMenus.onClicked.addListener(handleMenu);

importScripts("location-cache.js");

importScripts("blocked-stats.js");

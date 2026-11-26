// The worker serializes updates so simultaneous tabs share one session count.
(() => {
  const isPrivate = chrome.extension.inIncognitoContext;
  let queue = Promise.resolve();
  let savedTotal, lastBadgeCount, database;

  function recordPrivate(ids) {
    // IndexedDB in the off-the-record profile survives worker suspension and
    // is discarded by the browser when that profile's last window closes.
    database ??= new Promise((resolve, reject) => {
      const open = indexedDB.open("private-blocked-posts", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("posts");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => { database = undefined; reject(open.error); };
    });
    return database.then(db => new Promise((resolve, reject) => {
      const tx = db.transaction("posts", ids.length ? "readwrite" : "readonly");
      const posts = tx.objectStore("posts");
      for (const id of ids) posts.put(1, id);
      const count = posts.count();
      tx.oncomplete = () => resolve(count.result);
      tx.onabort = () => reject(tx.error);
    }));
  }

  async function recordRegular(ids) {
    const batches = new Map();
    for (const id of ids) {
      const bucket = "blockedSession:" + id.slice(-2);
      if (!batches.has(bucket)) batches.set(bucket, []);
      batches.get(bucket).push(id);
    }
    const session = chrome.storage.session;
    const stored = await session.get(["blockedSession", ...batches.keys()]);
    if (savedTotal === undefined)
      savedTotal = (await chrome.storage.local.get("blockedAllTime")).blockedAllTime || 0;
    const state = stored.blockedSession || {base:savedTotal, count:0};
    const updates = {};
    for (const [bucket, incoming] of batches) {
      const seen = new Set(stored[bucket] ? stored[bucket].split(" ") : []);
      const before = seen.size;
      for (const id of incoming) seen.add(id);
      if (seen.size === before) continue;
      state.count += seen.size - before;
      updates[bucket] = [...seen].join(" ");
    }
    if (Object.keys(updates).length)
      await session.set({...updates, blockedSession:state});
    // If the worker stopped between writes, recover the aggregate on startup.
    const total = state.base + state.count;
    if (savedTotal !== total) {
      await chrome.storage.local.set({blockedAllTime:total});
      savedTotal = total;
    }
    return state.count;
  }

  async function draw(tabId, count) {
    try {
      await Promise.all([
        chrome.action.setBadgeText({tabId, text:count > 999 ? "999+" : String(count)}),
        chrome.action.setTitle({tabId, title:"Mute on X · " + count.toLocaleString() + " blocked this session"})
      ]);
    } catch { /* The tab may close during a redraw. */ }
  }

  function record(ids) {
    const next = queue.then(async () => {
      const count = await (isPrivate ? recordPrivate(ids) : recordRegular(ids));
      if (lastBadgeCount !== count) {
        lastBadgeCount = count;
        const tabs = await chrome.tabs.query({});
        await Promise.all(tabs.filter(tab => tab.incognito === isPrivate).map(tab => draw(tab.id, count)));
      }
      return count;
    });
    queue = next.catch(() => {});
    return next;
  }

  function refreshTab(tab) {
    if (tab.incognito !== isPrivate) return;
    // Wait for the initial count or a concurrent batch before painting.
    void queue.then(() => {
      if (lastBadgeCount !== undefined) return draw(tab.id, lastBadgeCount);
    });
  }
  chrome.tabs.onCreated.addListener(refreshTab);
  chrome.tabs.onUpdated.addListener((id, changes, tab) => {
    if (changes.status) refreshTab(tab);
  });
  chrome.tabs.onReplaced.addListener(id => {
    void chrome.tabs.get(id).then(refreshTab, () => {});
  });

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type === "private-block-count" && isPrivate && sender.id === chrome.runtime.id &&
        sender.url === chrome.runtime.getURL("filters.html")) {
      queue.then(() => reply(lastBadgeCount ?? 0));
      return true;
    }
    if (msg?.type !== "posts-blocked" || sender.id !== chrome.runtime.id || sender.origin !== "https://x.com" ||
        sender.frameId !== 0 || !sender.documentId || !sender.tab || sender.tab.incognito !== isPrivate ||
        !Array.isArray(msg.ids) || !msg.ids.length || msg.ids.length > 200 ||
        !msg.ids.every(id => typeof id === "string" && /^\d{1,20}$/.test(id))) return;
    record(msg.ids).then(() => reply(true), () => reply(false));
    return true;
  });
  if (!isPrivate) {
    // A shared default is briefly visible between a navigation and its tab
    // override. Keep it neutral, including when upgrading from 1.5.0.
    void chrome.action.setBadgeText({text:""});
    void chrome.action.setTitle({title:chrome.runtime.getManifest().action.default_title});
    void chrome.action.setBadgeBackgroundColor({color:"#155D59"});
    void chrome.action.setBadgeTextColor({color:"#FFFFFF"});
    void chrome.storage.session.getKeys().then(keys => {
      const legacy = keys.filter(key => key === "blockedPrivateSession" || key.startsWith("blockedPrivateSession:"));
      if (legacy.length) return chrome.storage.session.remove(legacy);
    }).catch(console.error);
  }
  chrome.runtime.onStartup.addListener(() => { void record([]).catch(console.error); });
  void record([]).catch(console.error);
})();

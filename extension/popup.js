(async () => {
  const inputs = [...document.querySelectorAll("input")];
  function update(values) {
    for (const input of inputs) input.checked = values[input.id] === true;
    document.getElementById("countryOptions").hidden = !values.usOnly;
  }
  const keys = inputs.map(input => input.id);
  const read = () => chrome.storage.local.get(keys).then(update);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && keys.some(key => key in changes)) void read();
  });
  await read();
  for (const input of inputs) {
    input.disabled = false;
    input.onchange = () => chrome.storage.local.set({ [input.id]: input.checked });
  }
})();

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const status = document.getElementById("status");
  const restore = document.getElementById("restore");
  const next = document.getElementById("next");
  async function readStatus() {
    const text = await chrome.tabs.sendMessage(tab.id, { type: "feed-status" }, { frameId: 0 }).catch(() => null);
    const filtering = document.querySelector("input:checked:not(#hideUnverified)");
    const needsRefresh = typeof text !== "string" && filtering && (!tab.url || tab.url.startsWith("https://x.com/"));
    status.textContent = needsRefresh ? "Open or refresh your x.com tab to connect the feed filters." : text || "";
    const metrics = text && await chrome.tabs.sendMessage(tab.id, {type: "feed-metrics"}, {frameId: 0}).catch(() => null);
    const details = [];
    if (metrics && document.getElementById("usOnly").checked) {
      details.push(metrics.requests + " About requests in this document");
      if (metrics.firstUsMs != null) details.push("first US post in " + metrics.firstUsMs + " ms");
      if (metrics.lastMs != null) details.push("last request " + metrics.last + " (" + metrics.lastMs + " ms)");
    }
    document.getElementById("metrics").textContent = details.join(" · ");
    restore.hidden = !document.getElementById("usOnly").checked;
    next.hidden = !metrics?.canCheckMore;
  }
  restore.onclick = () => chrome.storage.local.set({ usOnly: false });
  next.onclick = () => chrome.tabs.sendMessage(tab.id, { type: "feed-next" }, { frameId: 0 }).catch(() => {});
  await readStatus();
  setInterval(readStatus, 500);
})();

(async () => {
  const privateWindow = chrome.extension.inIncognitoContext;
  const key = "blockedSession";
  if (privateWindow) {
    document.getElementById("sessionLabel").textContent = "This private session";
    document.getElementById("lifetimeStat").hidden = true;
    async function readPrivateCount() {
      const count = await chrome.runtime.sendMessage({type:"private-block-count"});
      if (Number.isSafeInteger(count)) document.getElementById("blockedNow").textContent = count.toLocaleString();
    }
    await readPrivateCount();
    setInterval(readPrivateCount, 1000);
    return;
  }
  async function refresh() {
    const [snapshot, lifetime] = await Promise.all([
      chrome.storage.session.get(key),
      chrome.storage.local.get("blockedAllTime")
    ]);
    const current = snapshot[key];
    document.getElementById("blockedNow").textContent = (current?.count || 0).toLocaleString();
    const total = current ? current.base + current.count : lifetime.blockedAllTime || 0;
    document.getElementById("blockedTotal").textContent = total.toLocaleString();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "session" && key in changes) || (area === "local" && "blockedAllTime" in changes))
      void refresh();
  });
  await refresh();
})();

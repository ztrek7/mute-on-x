// Only an explicit public country/region pair enters the persistent cache.
// Viewer/author pairs are salted per installation; raw handles, URLs, text,
// and individual misses never enter the on-disk cache.
(() => {
  const inflight = new Map();
  const cadence = 1500;
  const diskKey = "feedVerifiedLocations";
  const valid = v => typeof v === "string" && /^[a-z0-9_]{1,15}$/.test(v);
  const validKey = k => typeof k === "string" && /^[a-z0-9_]{1,15}(?:@\d{1,20})?$/.test(k);
  const sessionKey = sender => sender.tab.incognito ? "feedPrivateLocationCache" : "feedLocationCache";
  const scopeFor = (sender, viewer) => valid(viewer) ? "viewer:" + viewer : "document:" + sender.documentId;
  let writes = Promise.resolve();
  function serial(fn) {
    const result = writes.then(fn);
    writes = result.catch(() => {});
    return result;
  }
  function fresh(entries, now) {
    return new Map(Object.entries(entries || {}).filter(([, v]) => v.until > now));
  }
  async function fingerprint(salt, viewer, handle) {
    const bytes =
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode([salt, viewer, handle].join("|")));
    return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
  }
  async function diskLookup(viewer, handles) {
    const cache = (await chrome.storage.local.get(diskKey))[diskKey];
    if (cache?.schema !== 2) return [];
    return Promise.all(
      handles.map(async handle => [handle, cache.entries[await fingerprint(cache.salt, viewer, handle)]]));
  }
  async function saveDisk(viewer, handle, item) {
    const cache = (await chrome.storage.local.get(diskKey))[diskKey] || {salt: crypto.randomUUID()};
    const entries = fresh(cache.schema === 2 ? cache.entries : {}, Date.now());
    const hash = await fingerprint(cache.salt, viewer, handle);
    entries.delete(hash);
    entries.set(hash, item);
    while (entries.size > 400) entries.delete(entries.keys().next().value);
    await chrome.storage.local.set({[diskKey]: {schema: 2, salt: cache.salt, entries: Object.fromEntries(entries)}});
  }
  async function stateFor(sender, viewer) {
    const key = sessionKey(sender);
    const state = (await chrome.storage.session.get(key))[key] || {};
    const scope = scopeFor(sender, viewer);
    const entries = state.scope === scope ? fresh(state.entries, Date.now()) : new Map();
    if (!sender.tab.incognito && !state.pause) {
      const cooldown = (await chrome.storage.local.get("feedRequestCooldown")).feedRequestCooldown;
      if (cooldown?.pause > Date.now()) Object.assign(state, cooldown);
    }
    const save = () =>
      chrome.storage.session.set({[key]: {...state, scope, entries: Object.fromEntries(entries)}});
    return {state, entries, save};
  }
  function pauseResult(state) {
    return {result: "unknown", reason: state.reason, until: state.pause, paused: true};
  }
  async function recordPause(state, sender, reason, retryAt = 0) {
    const now = Date.now();
    const base = {limited: 900_000, login: 60_000, access: 300_000, schema: 300_000, unavailable: 30_000}[reason];
    const limit = reason === "limited" ? 3600_000 : 300_000;
    state.strikes = state.reason === reason ? Math.min(6, (state.strikes || 0) + 1) : 1;
    state.pause = Math.max(state.pause || 0, now + Math.min(limit, base * 2 ** (state.strikes - 1)), retryAt);
    state.reason = reason;
    if (!sender.tab.incognito && (reason === "limited" || retryAt > now)) {
      await chrome.storage.local.set({feedRequestCooldown: {pause: state.pause, reason, strikes: state.strikes}});
    }
    return pauseResult(state);
  }
  async function reserve(msg, sender) {
    const now = Date.now();
    const {state, entries, save} = await stateFor(sender, msg.viewer);
    let hit = entries.get(msg.key);
    if (!hit && valid(msg.viewer) && !sender.tab.incognito) {
      hit = (await diskLookup(msg.viewer, [msg.key]))[0]?.[1];
    }
    if (hit?.until > now && (hit.result !== "unknown" || !(state.pause > now))) return hit;
    if (state.pause > now) return pauseResult(state);
    if (state.next > now || state.lease?.until > now)
      return {retry: Math.max(200, Math.min(1500, (state.next || 0) - now))};
    if (!(await chrome.storage.local.get("usOnly")).usOnly) return {retry: 1500};
    // One rolling allowance across all foreground documents in this profile.
    // Regular windows retain it across restarts. Keep private traffic in RAM.
    const store = sender.tab.incognito ? chrome.storage.session : chrome.storage.local;
    const budgetKey = sender.tab.incognito ? "feedPrivateRequestTimes" : "feedRequestTimes";
    const times = ((await store.get(budgetKey))[budgetKey] || []).filter(t => t > now - 3600_000);
    if (times.length >= 96) {
      state.pause = times[0] + 3600_000;
      state.reason = "budget";
      await save();
      return pauseResult(state);
    }
    times.push(now);
    await store.set({[budgetKey]: times});
    const token = crypto.randomUUID();
    state.lease = {token, until: now + 30_000};
    state.next = now + cadence;
    await save();
    return {token};
  }
  async function commit(msg, sender, token, visit) {
    const {state, entries, save} = await stateFor(sender, msg.viewer);
    if (token && state.lease?.token !== token) return {retry: cadence, visited: true};
    if (token) delete state.lease;
    const now = Date.now(), outcome = visit.outcome;
    const known = outcome === "us" || outcome === "other";
    // Keep a failed author out of the next recovery batch so other nearby
    // authors can be checked when the shared cooldown ends.
    let ttl = outcome === "unavailable" ? 120_000 : 10 * 60_000;
    if (known) ttl = visit.id && msg.key === msg.handle + "@" + visit.id ? 24 * 3600_000 : 30 * 60_000;
    const item = {result: known ? outcome : "unknown", reason: outcome, until: now + ttl};
    if (outcome === "unavailable")
      state.failures = (state.failures || 0) + 1;
    else if (known || outcome === "unknown")
      state.failures = 0;
    let cooldown;
    if (outcome === "limited" || visit.exhausted) {
      cooldown = await recordPause(state, sender, "limited", visit.retryAt);
    } else if (["login","access","schema"].includes(outcome)) {
      cooldown = await recordPause(state, sender, outcome, visit.retryAt);
    } else if (outcome === "unavailable" && (state.failures >= 3 || visit.retryAt > now)) {
      cooldown = await recordPause(state, sender, outcome, visit.retryAt);
      state.failures = 0;
    } else if (known && !(state.pause > now)) {
      state.strikes = 0;
    }
    if (outcome === "cancelled") item.until = now + 30_000;
    if (cooldown && !known && outcome !== "unavailable") item.until = cooldown.until;
    entries.delete(msg.key);
    entries.set(msg.key, item);
    while (entries.size > 400) entries.delete(entries.keys().next().value);
    await save();
    if (known && visit.viewer === msg.viewer && valid(msg.viewer) && !sender.tab.incognito)
      await saveDisk(msg.viewer, msg.key, item);
    return {...item, cooldown, visited: !!token};
  }

  async function resolve(msg, sender) {
    const grant = await serial(() => reserve(msg, sender));
    if (!grant.token) return grant;
    // Bind to the originating document. A replaced or closed timeline cannot
    // redirect the work into another page or trigger a fallback navigation.
    let observed, timeout;
    try {
      const request = chrome.tabs.sendMessage(sender.tab.id, {
        type: "read-account", handle: msg.handle, key: msg.key, viewer: msg.viewer
      }, {documentId: sender.documentId});
      observed = await Promise.race([request, new Promise(resolve => {
        timeout = setTimeout(() => resolve({outcome: "unavailable"}), 10_000);
      })]);
    } catch { /* Document was replaced. */ }
    finally { clearTimeout(timeout); }
    return serial(() => commit(msg, sender, grant.token, observed || {outcome: "cancelled"}));
  }
  function lookup(msg, sender) {
    const key = [sessionKey(sender), scopeFor(sender, msg.viewer), msg.key].join("/");
    if (inflight.has(key)) return inflight.get(key).then(result => ({...result, visited: false}));
    const job = resolve(msg, sender).finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.origin !== "https://x.com" || sender.frameId !== 0 || !sender.tab || !sender.documentId) return;
    if (msg.type === "feed-location-snapshot") {
      serial(async () => {
        const {state, entries} = await stateFor(sender, msg.viewer);
        if (valid(msg.viewer) && !sender.tab.incognito) {
          const handles = [...new Set(msg.handles || [])].filter(validKey).slice(0, 400);
          for (const [name, item] of await diskLookup(msg.viewer, handles))
            if (item?.until > Date.now()) entries.set(name, item);
        }
        const hasPersistent =
          !msg.viewer && !sender.tab.incognito && (await chrome.storage.local.get(diskKey))[diskKey]?.schema === 2;
        return {entries: Object.fromEntries(entries), pause: state.pause, reason: state.reason, hasPersistent};
      }).then(reply, () => reply(null));
      return true;
    }
    if (!valid(msg.handle)) return;
    msg.key ||= msg.handle;
    if (!validKey(msg.key) || msg.key.split("@")[0] !== msg.handle) return;
    if (msg.type === "feed-location")
      lookup(msg, sender).then(reply, () => reply(null));
    else
      return;
    return true;
  });
})();

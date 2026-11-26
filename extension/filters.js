(() => {
  let status = "", enabledAt = performance.now(), firstUsMs = null, activeRead;
  const batchSize = 16;
  let lastPage = "", pendingPage, pageTimer, advances = 0, userAdvance = false, canCheckMore = false;
  let remaining = 0, idleSince = null;
  let viewer = feedViewer(), generation = 0;
  const requested = new Set();
  const postContent =
    "a[href*=\"/status/\"],[data-slot=\"embedded-tweet-frame\"],[data-testid=\"tweetText\"],div.whitespace-pre-wrap[dir=\"auto\"]";
  const candidate = "article:is([data-testid=\"tweet\"],:has(" + postContent + ")):not(article article),[role=link][data-href*='/status/'] > article:not(article article)";
  let parsed = new WeakMap();
  let previousDecisions = new Map(), layoutDirty = true, hasPending = false, scrollTimer;
  const locations = new Map();
  let cacheReady = false, readingCache = false, pause, identityDeadline = 0;
  const languages = new WeakMap();
  const settings = {usOnly: false, hideUnverified: false, hideNonEnglish: false, hideAllCaps: false, hideRepeatedText: false, hideAlertHeadlines: false};
  const checksPostStyle = () => settings.hideAllCaps || settings.hideRepeatedText || settings.hideAlertHeadlines;
  const anyFilterEnabled = () => settings.usOnly || settings.hideNonEnglish || checksPostStyle();
  let timer, retry, working, style;
  let currentPath = location.pathname, seenFeed = false;
  let waitingFor, waitStarted;
  const schedule = () => {
    if (!timer) {
      timer = true;
      queueMicrotask(() => {
        timer = false;
        refresh();
      });
    }
  };
  const monitor = new MutationObserver(records => {
    let changed = false;
    const invalidate = el => parsed.delete(el);
    for (const record of records) {
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      const owner = target?.closest("article");
      if (record.attributeName === "alt" && !(settings.hideAlertHeadlines || settings.hideRepeatedText)) continue;
      if (record.attributeName === "aria-label") {
        if (!owner || !settings.hideNonEnglish) continue;
        if (!feedPosts.isTranslationLabel(record.oldValue) && !feedPosts.isTranslationLabel(target.getAttribute("aria-label"))) continue;
      }
      if (record.attributeName === "hidden" || record.attributeName === "aria-hidden") {
        if (owner) {
          const affectsStyle = checksPostStyle() && feedPosts.containsBodyText(target);
          const rowVisibility = owner === target && record.attributeName === "hidden";
          if (!rowVisibility && !affectsStyle && !(settings.hideNonEnglish && feedPosts.visibilityAffectsLanguage(target))) continue;
        } else {
          const spacer = !target.childElementCount && target.parentElement?.hasAttribute("data-mox-compact");
          const viewerControls = profileLinks + "," + accountSwitcher;
          const viewerChanged = record.attributeName === "hidden" && settings.usOnly &&
            (target.closest(viewerControls) || target.querySelector(viewerControls));
          const articles = record.attributeName === "hidden" ? target.querySelectorAll("article") : [];
          articles.forEach(invalidate);
          if (!spacer && !viewerChanged && !articles.length) continue;
        }
      }
      if (owner && owner !== target && (record.attributeName === "style" || record.attributeName === "class")) {
        // The modern post-body selector is class based. Keep its transitions,
        // while ignoring cosmetic changes such as hover and video progress.
        const wasBody = record.attributeName === "class" && /(?:^|\s)whitespace-pre-wrap(?:\s|$)/.test(record.oldValue || "");
        const isBody = target.classList.contains("whitespace-pre-wrap");
        if (record.attributeName === "style" || wasBody === isBody) continue;
      }
      changed = true;
      if (!owner || owner === target || record.type === "childList") layoutDirty = true;
      for (let article = owner; article;
        article = article.parentElement?.closest("article")) {
        invalidate(article);
      }
      // The outer permalink may be on the wrapper or its direct overlay link.
      if (!owner && (record.type === "childList" || ["href", "data-href", "role"].includes(record.attributeName))) {
        const overlayChanged = target?.matches("a") && (record.type === "childList" || record.attributeName === "href");
        const wrapper = overlayChanged ? target.parentElement : target;
        wrapper?.querySelectorAll(":scope > article").forEach(invalidate);
      }
      if (record.type === "childList") {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          // A virtual timeline can edit a detached article and insert it again.
          if (node.matches("article")) invalidate(node);
          node.querySelectorAll("article").forEach(invalidate);
        }
      }
    }
    if (changed) schedule();
  });
  async function readCachedLocations(handles = []) {
    if (readingCache) return;
    readingCache = true;
    const reader = viewer, previousPause = pause;
    handles.forEach(handle => requested.add(handle));
    try {
      const state = await chrome.runtime.sendMessage({type: "feed-location-snapshot", viewer, handles});
      if (reader !== viewer) return;
      const now = Date.now();
      if (!reader && state?.hasPersistent && !identityDeadline) {
        identityDeadline = now + 5000;
        setTimeout(schedule, 5000);
      }
      for (const [handle, item] of locations)
        if (item.until <= now) locations.delete(handle);
      for (const [handle, item] of Object.entries(state?.entries || {})) {
        if (item.until > now && item.until > (locations.get(handle)?.until || 0)) locations.set(handle, item);
      }
      while (locations.size > 400) locations.delete(locations.keys().next().value);
      if (pause === previousPause) {
        pause = state?.pause > now ? {result: "unknown", reason: state.reason, until: state.pause, paused: true} : null;
      }
    } catch { /* A subsequent individual lookup can still resolve a location. */
    } finally {
      cacheReady = true;
      readingCache = false;
      schedule();
    }
  }
  function activePause(now = Date.now()) {
    return settings.usOnly && pause?.until > now ? pause : null;
  }
  function cancelPageTimer() {
    clearTimeout(pageTimer);
    pendingPage = null;
  }
  function resetPagination() {
    cancelPageTimer();
    lastPage = "";
    advances = 0;
    userAdvance = false;
  }
  function grantBatch() {
    remaining = batchSize;
    idleSince = null;
    resetPagination();
    schedule();
  }
  let showingLocationsHere = false;
  function showLocationsHere() {
    if (!settings.usOnly) return;
    // This page shares its DOM with X. Only the popup can change the saved preference.
    settings.usOnly = false;
    showingLocationsHere = true;
    configure();
  }
  function configure() {
    if (!settings.usOnly) activeRead?.abort();

    monitor.disconnect();
    parsed = new WeakMap();
    resetPagination();
    if (settings.usOnly) void readCachedLocations();
    if (anyFilterEnabled()) {
      monitor.observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["href", "data-href", "lang", "data-testid", "data-slot", "dir", "role", "class", "style", "alt", "aria-label", "aria-hidden", "hidden"]
      });
    }
    schedule();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.keys(settings).some(k => k in changes)) return;
    for (const k of Object.keys(settings))
      if (k in changes) settings[k] = changes[k].newValue === true;
    if (changes.usOnly) showingLocationsHere = false;
    if (changes.usOnly?.newValue === true) {
      cacheReady = false;
      enabledAt = performance.now();
      firstUsMs = null;
      grantBatch();
    }
    configure();
  });
  chrome.storage.local.get(settings).then(initial => {
    Object.assign(settings, initial);
    if (settings.usOnly) grantBatch();
    configure();
  });
  document.addEventListener("visibilitychange", () => {
    if (chrome.runtime?.id && !document.hidden && settings.usOnly) void readCachedLocations();
    schedule();
  });
  window.navigation?.addEventListener("currententrychange", schedule);
  window.addEventListener("popstate", schedule);

  // Browser-generated scroll events also follow scrollTo(), scroll anchoring
  // and layout changes. They update viewport geometry but never grant work.
  document.addEventListener("scroll", () => {
    if (!hasPending || !settings.usOnly || !remaining || working || activePause() || document.hidden || scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (settings.usOnly && !working && !document.hidden) schedule();
    }, 150);
  }, {capture:true, passive:true});
  function readingInput(event) {
    if (!event.isTrusted || document.hidden || !settings.usOnly) return false;
    const el = event.target;
    if (!(el instanceof Element)) return false;
    const controls = 'input,textarea,select,[contenteditable]:not([contenteditable=false]),aside,nav,[role=dialog],[role=complementary]';
    if (el.closest(controls)) return false;
    return el === document.body || el === document.documentElement || !!el.closest('main,[role=main]');
  }
  let lastWheel = -Infinity;
  document.addEventListener("wheel", event => {
    if (!readingInput(event) || event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const now = performance.now();
    const newGesture = now - lastWheel > 800;
    lastWheel = now;
    if (newGesture) grantBatch();
  }, {capture: true, passive: true});
  document.addEventListener("keydown", event => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || !readingInput(event)) return;
    if (event.key === " " && event.target.closest('button,[role=button]')) return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) grantBatch();
  }, true);
  let touchY = null;
  document.addEventListener("touchstart", event => {
    touchY = readingInput(event) && event.touches.length === 1 ? event.touches[0].clientY : null;
  }, {capture: true, passive: true});
  document.addEventListener("touchmove", event => {
    if (!event.isTrusted || event.touches.length !== 1 || touchY === null) return;
    if (Math.abs(event.touches[0].clientY - touchY) >= 12) {
      touchY = null;
      if (readingInput(event)) grantBatch();
    }
  }, {capture: true, passive: true});
  function advance() {
    if (!canCheckMore || activePause()) return false;
    grantBatch();
    userAdvance = true;
    return true;
  }
  // A parsed post is disposable when X recycles a row. The worker deduplicates
  // the numeric status ID across documents and tabs before acknowledging it.
  const reported = new Set(), pendingBlocks = new Set();
  let sendingBlocks = false, retryBlocks;
  async function sendBlocks() {
    if (sendingBlocks || retryBlocks || !pendingBlocks.size) return;
    sendingBlocks = true;
    const ids = [];
    for (const id of pendingBlocks) {
      ids.push(id);
      if (ids.length === 200) break;
    }
    try {
      if (!await chrome.runtime.sendMessage({type:"posts-blocked", ids})) throw new Error();
      for (const id of ids) {
        pendingBlocks.delete(id);
        reported.add(id);
      }
      while (reported.size > 2048) reported.delete(reported.values().next().value);
    } catch {
      if (chrome.runtime.id) retryBlocks = setTimeout(() => { retryBlocks = null; void sendBlocks(); }, 5000);
      else pendingBlocks.clear();
    } finally {
      sendingBlocks = false;
    }
    if (pendingBlocks.size && !retryBlocks) void sendBlocks();
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === "feed-metrics") reply({...aboutMetrics, firstUsMs, canCheckMore});
    if (msg.type === "read-account") {
      if (!settings.usOnly || activeRead || msg.viewer !== viewer || !working || waitingFor !== msg.key) {
        reply({outcome: "cancelled"});
        return;
      }
      const controller = new AbortController();
      activeRead = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
      fetchAccount(msg, signal).catch(() => ({outcome: "unavailable"})).then(reply)
        .finally(() => { if (activeRead === controller) activeRead = null; });
      return true;
    }
    if (msg.type === "feed-status") reply(status);
    if (msg.type === "feed-next") reply(advance());
  });
  function checkPageEnd(posts, ready) {
    if (!ready || !posts.length || document.hidden || advances >= 3) {
      cancelPageTimer();
      return;
    }
    const end = posts[posts.length - 1];
    const signature = currentPath + "|" + posts.length + "|" +
      (end.querySelector("a[href*=\"/status/\"]")?.href || end.textContent.slice(0, 80));
    if (signature === pendingPage) return;
    cancelPageTimer();
    if (signature === lastPage) return;
    pendingPage = signature;
    pageTimer = setTimeout(() => {
      pendingPage = null;
      if (activePause() || !end.isConnected || document.hidden || !(settings.usOnly || settings.hideNonEnglish || settings.hideAllCaps)) return;
      // Intersection-based loaders already see the compacted end. Scroll-only
      // loaders also need to remeasure when the list shrinks without a gesture.
      let scroller = end.parentElement;
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
        scroller = scroller.parentElement;
      const target = scroller || document;
      const viewport = scroller || document.scrollingElement;
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const byRequest = userAdvance;
      userAdvance = false;
      if (byRequest && distance > 1) {
        viewport.scrollBy({top: Math.min(distance, viewport.clientHeight), behavior: "instant"});
      } else if (distance > viewport.clientHeight)
        return;
      lastPage = signature;
      advances++;
      target.dispatchEvent(new Event("scroll", {bubbles: true}));
    }, 350);
  }
  function checkLanguage(article, bodies) {
    let item = languages.get(article);
    if (item?.bodies === bodies) return item.hidden;
    const signature = JSON.stringify(bodies);
    if (item?.signature !== signature) {
      item = {signature, bodies, hidden: false, pending: true};
      languages.set(article, item);
      feedPosts.nonEnglish(bodies)
        .then(result => {
          if (languages.get(article) === item) {
            item.hidden = result;
            item.pending = false;
            schedule();
          }
        })
        .catch(() => {
          item.hidden = false;
          item.pending = false;
          schedule();
        });
    }
    item.bodies = bodies;
    return item.hidden;
  }
  async function checkLocation(handle) {
    let delay = 30;
    const version = generation;
    if (waitingFor !== handle) {
      waitingFor = handle;
      waitStarted = Date.now();
    }
    try {
      const grant = await chrome.runtime.sendMessage(
        {type: "feed-location", key: handle, handle: handle.split("@")[0], viewer});
      if (grant?.visited || !grant) remaining = Math.max(0, remaining - 1);
      if (version !== generation) return;
      if (grant?.result) {
        if (locations.size >= 400) locations.delete(locations.keys().next().value);
        locations.set(handle, grant);
        if (grant.paused || grant.cooldown) {
          pause = grant.cooldown || grant;
          userAdvance = false;
          schedule();
        }
      } else if (grant?.retry && Date.now() - waitStarted < 45_000)
        delay = grant.retry;
      else
        locations.set(handle, {result: "unknown", until: Date.now() + 60_000});
    } catch {
      // A lost worker reply can follow a completed GET. Charge it once.
      remaining = Math.max(0, remaining - 1);
      locations.set(handle, {result: "unknown", until: Date.now() + 60_000});
      delay = 3000;
    } finally {
      clearTimeout(retry);
      retry = setTimeout(() => {
        working = null;
        schedule();
      }, delay);
    }
  }
  let disconnected = false;
  function refresh() {
    if (disconnected || !document.body) return;
    // Unpacked reloads invalidate the API but leave this document and its
    // observer alive. Restore existing rows before another stale scan runs.
    if (!chrome.runtime?.id) {
      disconnected = true;
      monitor.disconnect();
      activeRead?.abort();
      cancelPageTimer();
      clearTimeout(retry);
      clearTimeout(retryBlocks);
      pendingBlocks.clear();
      feedLayout.apply(new Map(), false);
      style?.remove();
      emptyFeedHint.update(null);
      return;
    }
    if (currentPath !== location.pathname) {
      currentPath = location.pathname;
      seenFeed = false;
      firstUsMs = null;
      enabledAt = performance.now();
      activeRead?.abort();
      resetPagination();
    }
    const currentViewer = feedViewer();
    if (viewer !== currentViewer) {
      activeRead?.abort();
      if (firstUsMs !== null) {
        firstUsMs = null;
        enabledAt = performance.now();
      }
      viewer = currentViewer;
      identityDeadline = 0;
      generation++;
      locations.clear();
      requested.clear();
      pause = null;
      cacheReady = false;
      resetPagination();
      if (settings.usOnly) void readCachedLocations();
    }
    const feed =
      !/^\/(?:settings|login|messages|compose|i\/(?:flow|jf|chat|grok)|[^/]+\/about)(?:\/|$)/i.test(currentPath);
    const enabled = feed && anyFilterEnabled();
    if (enabled && !style?.isConnected) {
      style = document.createElement("style");
      style.textContent = feedLayout.stylesheet;
      document.documentElement.append(style);
    }

    const now = Date.now();
    const gate = activePause(now);
    let shown = 0, confirmedUs = 0, detecting = false;
    let next, waiting = 0, unchecked = 0, pausedRows = 0, unavailable = 0, other = 0, expiry = gate?.until ?? Infinity;
    const posts = enabled ? document.querySelectorAll(candidate) : [];
    const decisions = new Map();
    const pending = new Map();
    const handles = new Set();
    for (const article of posts) {
      let post = parsed.get(article);
      if (!post) {
        post = feedPosts.read(article, settings);
        parsed.set(article, post);
      }
      const {authors, bodies, translated} = post;

      let hide = post.styleMatch || (settings.hideNonEnglish && (translated || checkLanguage(article, bodies)));
      let blocked = hide;
      const languagePending = settings.hideNonEnglish && !translated && languages.get(article)?.pending;
      detecting ||= languagePending;
      if (settings.usOnly && !hide) {
        const results = authors.map(handle => {
          if (!handle) return "unknown";
          handles.add(handle);
          const cached = locations.get(handle);
          const item = cached?.until > now ? cached : gate;
          if (item?.until > now) {
            expiry = Math.min(expiry, item.until);
            if (item === gate || item.paused || (item.result === "unknown" && item.cooldown && gate))
              return "paused";
            if (item.reason === "unknown") return "unverified";
            return item.result;
          }
          return "pending";
        });
        const otherCountry = results.includes("other");
        const paused = results.includes("paused");
        const unverified = results.includes("unverified");
        const missing = paused || unverified || results.includes("unknown");
        const unresolved = results.indexOf("pending");
        if (paused && !otherCountry) pausedRows++;
        else if (missing && (settings.hideUnverified || !otherCountry)) unavailable++;
        else if (otherCountry) other++;
        if (!otherCountry && unresolved !== -1 && !languagePending && (!settings.hideUnverified || !missing))
          pending.set(article, authors[unresolved]);
        if (!missing && !otherCountry && unresolved === -1 && !languagePending) confirmedUs++;
        // Counting waits for a completed exclusion while strict mode can
        // temporarily collapse pending checks, cooldowns and incomplete rows.
        blocked = otherCountry || (settings.hideUnverified && unverified);
        hide = otherCountry || (settings.hideUnverified && (missing || unresolved !== -1));
      }
      // Leave an already concealed site row alone. Its later reveal will be
      // observed, and a row we collapsed remains eligible for a late ID.
      if (hide && (article.closest("[hidden]") ||
          (!article.closest("[data-mox-hide]") && !article.checkVisibility()))) {
        hide = false;
        blocked = false;
      }
      if (blocked && post.id && !reported.has(post.id)) pendingBlocks.add(post.id);
      decisions.set(article, hide);
      if (!hide) shown++;
    }
    if (layoutDirty || decisions.size !== previousDecisions.size ||
        [...decisions].some(([article, hide]) => previousDecisions.get(article) !== hide)) {
      feedLayout.apply(decisions, !(settings.usOnly && settings.hideUnverified));
      previousDecisions = decisions;
      layoutDirty = false;
    }
    void sendBlocks();
    hasPending = pending.size > 0;
    if (settings.usOnly && confirmedUs && firstUsMs === null) firstUsMs = Math.round(performance.now() - enabledAt);
    // A collapsed row has no viewport rectangle. Its insertion point is
    // bounded by neighboring retained rows in the same scroll container.
    const following = new Map();
    let below;
    if (settings.hideUnverified && pending.size) {
      for (const article of [...posts].reverse()) {
        if (!decisions.get(article)) below = article.getBoundingClientRect().top;
        else if (pending.has(article)) following.set(article, below);
      }
    }
    // All descendants of a common container share the same scroll bounds in this pass.
    const scrollBounds = new Map();
    function viewportFor(el) {
      if (!el) return {top:0, bottom:innerHeight};
      if (scrollBounds.has(el)) return scrollBounds.get(el);
      const bounds = /^(auto|scroll)$/.test(getComputedStyle(el).overflowY) ?
        el.getBoundingClientRect() : viewportFor(el.parentElement);
      scrollBounds.set(el, bounds);
      return bounds;
    }
    let above, best = Infinity;
    const near = new Set();
    for (const article of posts) {
      if (!pending.size) break;
      if (!pending.has(article)) {
        if (settings.hideUnverified && !decisions.get(article)) above = article.getBoundingClientRect().bottom;
        continue;
      }
      const handle = pending.get(article);
      const bounds = viewportFor(article.parentElement);
      const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
      let distance;
      if (settings.hideUnverified) {
        const y = above ?? following.get(article) ?? article.closest("main,[role=main]")?.getBoundingClientRect().top ?? 0;
        distance = Math.max(0, top - y, y - bottom);
      } else {
        const rect = article.getBoundingClientRect();
        distance = Math.max(0, top - rect.bottom, rect.top - bottom);
      }
      if (distance > Math.max(120, (bottom - top) / 2)) continue;
      near.add(handle);
      if (distance < best) {
        best = distance;
        next = handle;
      }
    }
    // Cached authors remain available after unused network credits expire.
    if (idleSince !== null && performance.now() - idleSince >= 18_000) remaining = 0;
    if (remaining < batchSize && !next && !working && !(pause?.until > now) && !detecting) {
      idleSince ??= performance.now();
    } else {
      idleSince = null;
    }
    unchecked = remaining === 0 ? near.size : 0;
    waiting = Math.min(near.size, remaining);
    if (!remaining) next = null;
    for (const handle of requested)
      if (!handles.has(handle)) requested.delete(handle);
    const cold = [...handles].filter(h => !requested.has(h));
    if (viewer && cold.length && !readingCache) void readCachedLocations(cold.slice(0, 400));
    const ready = !settings.usOnly || (cacheReady && !gate);
    const noMatches = posts.length > 0 && ready && !shown && !waiting && !unchecked && !detecting;
    const paginate = settings.usOnly || settings.hideNonEnglish || settings.hideAllCaps;
    canCheckMore = paginate && ready && (unchecked > 0 || noMatches);
    const counts = [];
    if (enabled && posts.length) {
      seenFeed = true;
      counts.push(shown + " shown");
      if (waiting) counts.push(waiting + " checking location");
      if (pausedRows) counts.push(pausedRows + " waiting for location checks");
      if (unavailable) counts.push(unavailable + " location unavailable");
      if (other) counts.push(other + " other country or region");
      if (ready && unchecked) counts.push(unchecked + " awaiting another batch · Scroll or choose Check more posts");
      if (noMatches) counts.push("No matches in the loaded posts");
    }
    if (enabled && !posts.length && settings.usOnly && (seenFeed || currentPath === "/home")) {
      counts.push("No loaded posts to verify. Choose Show all locations to restore the feed.");
    }
    if (enabled && gate) {
      const reasons = {
        budget: "Hourly lookup allowance used",
        schema: "X’s About response changed",
        access: "X denied access; check sign-in or verification in your X tab",
        limited: "X limited lookups",
        login: "X sign-in required or access restricted",
        unavailable: "X’s location service is temporarily unavailable"
      };
      counts.push(reasons[gate.reason] || "Location checks paused");
      counts.push("Next check at " + new Date(gate.until).toLocaleTimeString());
    }
    const main = document.querySelector("main,[role=main]");
    const hint = settings.usOnly && settings.hideUnverified && enabled && !shown && counts.length ? "US-only · " + counts.join(" · ") : "";
    emptyFeedHint.update(main, hint, canCheckMore, advance, showLocationsHere);
    if (showingLocationsHere && feed) counts.push("Showing all locations in this tab until reload");
    status = counts.join(" · ");
    checkPageEnd(posts, paginate && noMatches);
    if (next && (viewer || now >= identityDeadline) && cacheReady && !readingCache && !working &&
      !document.hidden) {
      working = true;
      void checkLocation(next);
    } else if (!working && expiry < Number.MAX_SAFE_INTEGER) {
      clearTimeout(retry);
      retry = setTimeout(schedule, Math.min(2_147_000_000, Math.max(100, expiry - now)));
    }
  }
})();

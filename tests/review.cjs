const assert = require("node:assert/strict");

const post = (author, id = author) => "<article data-testid=\"tweet\" id=\"" + id + "\"><a href=\"/" + author +
  "/status/123\">@" + author +
  "</a><div data-testid=\"tweetText\" lang=\"en\">A report from the park.</div></article>";
exports.serveReview = (req, res, visits) => {
  const nav = "<nav><a data-testid=\"AppTabBar_Profile_Link\" href=\"/fixtureviewer\">Profile</a></nav>";
  if (req.url.startsWith("/bench-feed")) {
    const viewer = req.url.includes("other") ? "otherviewer" : "fixtureviewer";
    const markup = nav.replace("/fixtureviewer", "/" + viewer);
    const identity = req.url.includes("delayed") ?
      "<script>setTimeout(()=>document.body.insertAdjacentHTML(\"afterbegin\"," + JSON.stringify(markup) +
        "),900)</script>" :
      markup;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(identity + "<main><header>For you</header><section>" +
      Array.from({length: 16}, (_, i) => post("queue" + (i + 1))).join("") + post("queue1", "duplicate1") +
      post("queue16", "duplicate16") + "</section></main>");
    return true;
  }
  if (req.url === "/shared-feed") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(nav + "<main>" + post("slowpanel") + post("slowpanel", "again") + "</main>");
    return true;
  }
  return false;
};

exports.runReview = async ({source, observer, until, visits, restart}, scenario) => {
  if (["count-location", "count-identity", "count-links"].includes(scenario)) return require("./hide-count.cjs")({source,observer,until}, scenario);
  if (scenario === "post-style") return require("./post-style.cjs")({source, observer, until, restart, visits});
  if (scenario === "caps") return require("./caps.cjs")({source, observer, until, restart, visits});
  if (scenario === "private-stats") return require("./blocked-stats.cjs").privateWindow({source, observer, until});
  if (scenario === "blocked-stats") return require("./blocked-stats.cjs")({source, observer, until, restart});
  const enabled = value => observer.evaluate(usOnly => chrome.storage.local.set({usOnly}), value);
  const sourceId =
    await observer.evaluate(async () => (await chrome.tabs.query({active: true, currentWindow: true}))[0].id);
  const state = () =>
    observer.evaluate(() => chrome.storage.session.get("feedLocationCache")).then(v => v.feedLocationCache);
  const feed = async names => {
    await source.goto("https://x.com/home");
    await source.evaluate(html => {
      document.body.innerHTML =
        "<main><header>For you</header><section aria-label=\"Timeline\">" + html + "</section></main>";
    }, names.map(n => post(n)).join(""));
  };
  if (scenario === "reading-position") {
    for (const nested of [false, true]) {
      for (const nativeAnchor of ["auto", "none"]) {
        await source.goto("https://x.com/shared-feed");
        await source.addStyleTag({content: `
          html, #timeline { overflow-anchor:${nativeAnchor} }
          body { margin:0 }
          article { height:128px }
          ${nested ? "#timeline { height:420px; overflow:auto }" : ""}
        `});
        await source.evaluate(html => {
          document.querySelector("main").innerHTML = '<section id="timeline">' + html + '</section>';
        }, Array.from({length:22}, (_, i) => post("local", "row"+i)).join(""));
        await observer.evaluate(() => chrome.storage.local.set({usOnly:true, hideNonEnglish:true}));
        const measure = () => source.locator("#row8").evaluate(el => el.getBoundingClientRect().top);
        await source.locator("#row8").evaluate(el => el.scrollIntoView({block:"start"}));
        await source.locator("#row8").evaluate((el, nested) => {
          (nested ? el.closest("#timeline") : document.scrollingElement).scrollBy(0, -40);
        }, nested);
        const before = await measure();
        // Row 7 straddles the top edge, while row 8 is being read.
        for (const i of [5, 7, 12]) {
          await source.locator("#row"+i+" [data-testid=tweetText]").evaluate(el => {
            el.lang = "es"; el.textContent = "Buenos días a todos.";
          });
          await until(() => source.locator("#row"+i).isHidden(), "earlier or later row removed");
          const delta = (await measure()) - before;
          assert.ok(Math.abs(delta) <= 1, `reading position moved ${delta}px; nested=${nested}, overflow-anchor=${nativeAnchor}, row=${i}`);
        }
        console.log("PASS reading position held for removals above and below", {nested,nativeAnchor});
      }
    }
    return;
  }
  if (["scroll-reveal", "scroll-recycle", "scroll-sentinel", "scroll-spacers"].includes(scenario))
    return require("./scroll.cjs").run({source, observer, until, visits, state, post}, scenario);
  if (scenario === "virtual-window") {
    await source.goto("https://x.com/shared-feed");
    await source.evaluate(html => {
      const main = document.querySelector("main");
      main.innerHTML = '<section id="window" style="position:relative;min-height:4000px">' + html + '</section>';
      document.querySelector("#r9").scrollIntoView();
    }, Array.from({length:8}, (_, i) => {
      const n = i+7;
      return '<div data-testid="cellInnerDiv" style="position:absolute;width:100%;height:150px;top:0;transform:translateY(' +
        n*150 + 'px)">' + post("local","r"+n) + '</div>';
    }).join(""));
    const measure = () => source.evaluate(() => {
      const box = document.querySelector("#window").getBoundingClientRect();
      const row = n => document.querySelector("#r"+n).parentElement.getBoundingClientRect();
      return {leading:row(7).top-box.top, trailing:box.bottom-row(14).bottom, reading:row(9).top};
    });
    const before = await measure();
    await source.locator("#r8 [data-testid=tweetText]").evaluate(el => {el.textContent="Buenos días"; el.lang="es";});
    await observer.evaluate(() => chrome.storage.local.set({hideNonEnglish:true}));
    await until(() => source.locator("#r8").isHidden(), "interior row filtered");
    assert.deepEqual(await measure(), before, "unmounted ranges and reader position preserved");
    await source.locator("#r7").evaluate(el => el.parentElement.remove());
    await until(() => source.locator("#r9").evaluate(el =>
      Math.abs(el.parentElement.getBoundingClientRect().top - document.querySelector("#window").getBoundingClientRect().top - 1200) < 1),
      "leading offset follows the virtualizer when its first mounted row changes");
    console.log("PASS unmounted ranges, reading position and recycled window");
    return;
  }
  if (scenario === "background-feed") {
    await source.goto("https://x.com/shared-feed");
    await source.evaluate(html => {
      document.querySelector("main").insertAdjacentHTML("beforeend", html);
      document.querySelector("#spanish [data-testid=tweetText]").lang = "es";
      document.querySelector("#spanish [data-testid=tweetText]").textContent = "Buenos días a todos.";
      document.querySelector("main").insertAdjacentHTML("afterend", '<footer style="height:200vh"></footer>');
    }, post("maple") + post("absent") + post("limited") + post("maple", "spanish"));
    await observer.evaluate(() => chrome.storage.local.set({usOnly:true, hideNonEnglish:true}));
    await until(() => visits.some(v => v.name === "slowpanel"), "delayed country lookup started");
    assert.equal(await source.locator("#slowpanel").isVisible(), true, "feed readable while first country reply is pending");
    assert.ok(await source.locator("#spanish").isHidden(), "language filter works during a country lookup");
    await source.mouse.move(80, 80);
    await source.mouse.wheel(0, 100);
    await until(() => source.evaluate(() => scrollY > 0), "scroll works during delayed lookup");
    await until(() => source.locator("#maple").isHidden(), "confirmed non-US row removed", 12_000);
    assert.equal(await source.evaluate(() => document.querySelector("#absent").getBoundingClientRect().top -
      document.querySelector("#again").getBoundingClientRect().bottom), 0, "removed country row leaves no gap");
    await until(() => visits.some(v => v.name === "limited"), "rate limit reached", 12_000);
    const status = () => observer.evaluate(id => chrome.tabs.sendMessage(id, {type:"feed-status"}), sourceId);
    await until(async () => (await status()).includes("limited lookups"), "cooldown applied");
    assert.match(await status(), /waiting for location checks/);
    assert.ok(await source.locator("#absent").isVisible());
    assert.ok(await source.locator("#limited").isVisible());
    assert.ok(await source.locator("#again").isVisible());
    assert.equal(visits.filter(v => v.name === "slowpanel").length, 1);
    assert.equal((await observer.evaluate(() => events.filter(e => e.type === "create"))).length, 0);
    await observer.goto(new URL("/filters.html",observer.url()).href);
    await observer.locator("#hideUnverified").evaluate(el => el.click());
    await until(() => source.locator("#absent").isHidden(), "strict mode hides missing labels");
    await observer.locator("#hideUnverified").evaluate(el => el.click());
    await until(() => source.locator("#absent").isVisible(), "background mode restores unresolved post during cooldown");
    assert.ok(await source.locator("#spanish").isHidden());
    console.log("PASS readable during slow lookup and cooldown, confirmed country and language removed, duplicate reused, zero extra tabs");
    return;
  }
  // The original suite exercises the optional confirmed-US-only mode.
  await observer.evaluate(() => chrome.storage.local.set({hideUnverified:true}));
  if (scenario.startsWith("response-") || scenario.startsWith("pause-") || ["weak-id","modern-reset","zero-tabs","modern","cors","gates","stale","budget","signed-out"].includes(scenario)) {
    await require("./tabless.cjs").run({source,observer,until,visits,feed,enabled,state,sourceId,post},scenario);
  } else if (["idle-demand", "data-limit", "pending-limit", "late-append"].includes(scenario)) {
    await require("./demand.cjs").run({source, observer, until, visits, feed, enabled, state, sourceId, post}, scenario);
  } else if (scenario === "bench" || scenario === "bench-old") {
    const old = scenario === "bench-old";
    const watch = page => page.evaluate(() => {
      window.opens = [];
      window.closes = [];
      window.foregroundChanges = [];
      chrome.tabs.onActivated.addListener(info => foregroundChanges.push(info.tabId));
      chrome.windows.onFocusChanged.addListener(id => foregroundChanges.push(id));
      chrome.tabs.onCreated.addListener(t => opens.push({id: t.id, active: t.active}));
      chrome.tabs.onRemoved.addListener(id => closes.push(id));
    });
    await source.goto("https://x.com/bench-feed");
    await watch(observer);
    const origin = await observer.evaluate(async () => ({
      win: (await chrome.windows.getLastFocused()).id,
      id: (await chrome.tabs.query({active: true, currentWindow: true}))[0].id
    }));
    const scroll = await source.evaluate(() => {
      const footer = document.createElement("footer");
      footer.style.height = "1500px";
      document.body.append(footer);
      scrollTo(0, 80);
      return scrollY;
    });
    const status = () => observer.evaluate(id => chrome.tabs.sendMessage(id, {type: "feed-status"}), sourceId);
    const audit = page => {
      const counts = {xRequests: 0, xTopNavigations: 0, extensionTopNavigations: 0};
      const onRequest = req => {
        if (new URL(req.url()).origin === "https://x.com") counts.xRequests++;
      };
      const onFrame = frame => {
        if (frame.parentFrame()) return;
        if (new URL(frame.url()).origin === "https://x.com") counts.xTopNavigations++;
        else if (frame.url().startsWith("chrome-extension:")) counts.extensionTopNavigations++;
      };
      page.context().on("request", onRequest);
      for (const p of page.context().pages()) p.on("framenavigated", onFrame);
      page.context().on("page", p => p.on("framenavigated", onFrame));
      return counts;
    };
    const coldTraffic = audit(source);
    const start = Date.now();
    await enabled(true);
    await until(
      async () => /^([1-9]\d*) shown/.test(await status()) && await source.locator("#queue1").isVisible(),
      "confirmed first", 8000);
    const first = Date.now() - start;
    await until(async () => /^13 shown/.test(await status()), "first 12 confirmed", 60_000);
    const twelve = Date.now() - start;
    if (old) {
      await source.waitForTimeout(2500);
      assert.equal(visits.length, 12);
      await observer.evaluate(id => chrome.tabs.sendMessage(id, {type: "feed-next"}), sourceId);
    }
    await until(async () => /^18 shown/.test(await status()), "all 16 confirmed", 22_000);
    const total = Date.now() - start;
    const cold = await observer.evaluate(() => opens);
    assert.equal(cold.length, old ? 16 : 0);
    assert.ok(cold.every(t => !t.active));
    await until(
      async () => await observer.evaluate(() => closes.length === opens.length), "helper closes on idle", 26_000);
    const focus = await observer.evaluate(async () => ({
      win: (await chrome.windows.getLastFocused()).id,
      id: (await chrome.tabs.query({active: true, currentWindow: true}))[0].id
    }));
    assert.deepEqual(focus, origin);
    assert.deepEqual(await observer.evaluate(() => foregroundChanges), []);
    assert.equal(await source.evaluate(() => scrollY), scroll);
    const aboutLoads = visits.length;
    assert.equal(aboutLoads, 16);
    assert.equal(new Set(visits.map(v => v.name)).size, 16);
    const profiles = visits.profileLoads || 0;
    assert.equal(profiles, old ? 16 : 0);
    const warm = await restart();
    await watch(warm.observer);
    const id = await warm.observer.evaluate(
      async () => (await chrome.tabs.query({active: true, currentWindow: true}))[0].id);
    const warmTraffic = audit(warm.source);
    const t = Date.now();
    await warm.source.goto("https://x.com/bench-feed?delayed");
    const get = () =>
      warm.observer.evaluate(id => chrome.tabs.sendMessage(id, {type: "feed-status"}).catch(() => ""), id);
    let warmFirstMs;
    await until(async () => {
      const text = await get();
      if (/^[1-9]\d* shown/.test(text)) warmFirstMs ??= Date.now() - t;
      return old ? /^2 shown/.test(text) : /^18 shown/.test(text);
    }, "warm evidence", 8000);
    const warmMs = Date.now() - t;
    console.log(JSON.stringify({
      coldTraffic, warmTrafficIncludingUserFeedLoad: warmTraffic, firstMs: first,
      twelveMs: twelve,
      all16Ms: total,
      coldTabs: cold.length,
      coldAboutLoads: aboutLoads,
      coldProfileLoads: profiles,
      warmAboutLoads: visits.length - aboutLoads,
      warmProfileLoads: (visits.profileLoads || 0) - profiles,
      warmFirstMs, warmMs,
      warmDistinct: old ? 1 : 16,
      warmTabs: await warm.observer.evaluate(() => opens.length),
      coldVisits: visits.slice(0, 16).map(v => v.time - start)
    }));
    if (!old) {
      assert.equal(visits.length, 16);
      assert.equal(await warm.observer.evaluate(() => opens.length), 0);
      const saved = await warm.observer.evaluate(() => chrome.storage.local.get("feedVerifiedLocations"));
      assert.equal(Object.keys(saved.feedVerifiedLocations.entries).length, 16);
      assert.doesNotMatch(JSON.stringify(saved), /fixtureviewer|queue\d/i);
      await warm.source.goto("https://x.com/bench-feed?other");
      await until(() => visits.length > 16, "second viewer must verify independently");
      assert.ok(!/^18 shown/.test(await get()));
    }
  } else if (scenario === "reader") {
    await feed(["queue1","wrongname","noidentity","appstore","region","westasia","warnings","tombstone","missing"]);
    await enabled(true);
    await until(async () => !!(await state())?.entries.missing, "nine spaced author checks", 20_000);
    const entries = (await state()).entries;
    assert.equal(entries.queue1.result, "us");
    assert.equal(entries.noidentity.result, "us");
    assert.ok(entries.noidentity.until-Date.now() <= 30*60_000);
    for (const name of ["wrongname","appstore","region","westasia","warnings","tombstone","missing"]) {
      assert.equal(entries[name].result, "unknown");
      assert.ok(await source.locator("#"+name).isHidden());
    }
  } else if (scenario === "missing") {
    await feed(["noarea1", "noarea2", "queue1"]);
    const start = Date.now();
    await enabled(true);
    await until(
      () => source.locator("#queue1").isVisible(), "two individual misses still allow next US author", 36_000);
    console.log(
      "first eligible after two misses", Date.now() - start, "ms", visits.map(v => [v.name, v.time - start]));
    assert.deepEqual(visits.map(v => v.name), ["noarea1", "noarea2", "queue1"]);
    assert.equal(await source.locator("#noarea1").isHidden(), true);
    assert.ok(!(await state()).pause);
  } else if (scenario === "identity") {
    await feed(["numbered"]);
    await source.locator("#numbered")
      .evaluate(article => article.insertAdjacentHTML(
                  "afterbegin", "<div data-testid=\"User-Name\"><a href=\"/i/user/111\">@numbered</a></div>"));
    await enabled(true);
    await until(async () => (await state())?.entries["numbered@111"]?.result === "us", "matching native ID");
    assert.ok((await state()).entries["numbered@111"].until - Date.now() > 5 * 3600_000);
    await source.locator("[data-testid=\"User-Name\"] a").evaluate(link => link.href = "/i/user/222");
    await until(async () => (await state())?.entries["numbered@222"]?.result === "unknown",
      "recycled byline must verify new identity");
    assert.ok(await source.locator("#numbered").isHidden());
    assert.equal(visits.length, 2);
  } else if (scenario === "service") {
    await feed(["serverfail1", "serverfail2", "serverfail3", "queue1"]);
    await enabled(true);
    await until(async () => (await state())?.reason === "unavailable", "repeated HTTP failures back off");
    const snapshot = await state();
    assert.ok(snapshot.pause - Date.now() > 28_000 && snapshot.pause - Date.now() <= 30_000);
    assert.deepEqual(visits.map(v => v.name), ["serverfail1", "serverfail2", "serverfail3"]);
    // The fixture backend recovers. Keep the real clock and wait out the pause.
    visits.recovered = true;
    await until(
      async () => (await state())?.entries.queue1?.result === "us", "recovered without manual refresh", 48_000);
    assert.ok(visits[3].time >= snapshot.pause);
  } else if (scenario === "shared") {
    await source.goto("https://x.com/shared-feed");
    await enabled(true);
    await until(() => visits.length === 1, "late-hydrating About loaded");
    const other = await source.context().newPage();
    await other.goto("https://x.com/shared-feed");
    await other.bringToFront();
    await until(async () => (await state())?.entries.slowpanel?.result === "us" &&
        await other.locator("#slowpanel").isVisible(),
      "delayed data response", 9000);
    assert.deepEqual(visits.map(v => v.name), ["slowpanel"]);
    assert.equal(await other.evaluate(() => document.visibilityState), "visible");
    await enabled(false);
    await until(() => !source.context().pages().some(p => p.url().endsWith("/slowpanel/about")),
      "disable closes pool immediately");
    console.log("two tabs, two copies each, one About data request; delayed label confirmed");
  } else if (scenario === "bootstrap") {
    await feed(Array.from({length: 19}, (_, i) => "queue" + (i + 20)));
    await enabled(true);
    await until(async () => (await source.getByRole("button", {name: "Check more posts"}).isVisible()),
      "bounded empty bootstrap", 31_000);
    assert.equal(visits.length, 16);
    await source.getByRole("button", {name: "Check more posts"}).click();
    await until(async () => (await state())?.entries.queue38?.result === "us",
      "explicit resume reaches later eligible account");
    await until(async () => !(await source.locator("[data-mox-empty-feed]").count()),
      "inline status disappears after first match");
  } else if (scenario === "header" || scenario === "backoff") {
    await feed(["slow429", "queue1"]);
    await enabled(true);
    if (scenario === "header") {
      await until(() => source.getByRole("button", {name: "Show all locations"}).isVisible(),
        "empty feed offers inline recovery");
      const style = await source.getByRole("button", {name: "Show all locations"})
                      .evaluate(el => getComputedStyle(el.parentElement).position);
      assert.ok(!["fixed", "sticky", "absolute"].includes(style));
    }
    await until(async () => (await state())?.reason === "limited", "429 recorded");
    const pause = (await state()).pause - Date.now();
    assert.ok(pause >= 7198_000 && pause < 7210_000, "honor Retry-After then allow recovery: " + pause);
    assert.deepEqual(visits.map(v => v.name), ["slow429"]);
    if (scenario === "header") {
      await until(() => source.getByText(/X limited lookups/i).isVisible(), "rate limit explained by feed header");
      const second = await source.context().newPage();
      await second.goto("https://x.com/bench-feed");
      await until(() => second.getByText(/X limited lookups/i).isVisible(), "second tab enforces saved filter");
      await source.bringToFront();
      await observer.evaluate(() => chrome.storage.local.set({hideNonEnglish:true}));
      await source.locator("section").evaluate((section, html) => section.insertAdjacentHTML("beforeend",html),
        post("language").replace('lang="en">A report from the park.', 'lang="fr">Merci beaucoup.'));
      await source.getByRole("button", {name: "Show all locations until reload"}).click();
      await until(() => source.locator("#queue1").isVisible(), "inline recovery works");
      assert.ok(await source.locator("#language").isHidden(), "language filtering stays active");
      assert.ok(await second.locator("#queue1").isHidden(), "other tab still applies country filtering");
      assert.equal(await observer.evaluate(async () => (await chrome.storage.local.get("usOnly")).usOnly),true);
      await second.close();
    } else {
      const warm = await restart();
      await warm.observer.evaluate(() => {
        window.created = [];
        chrome.tabs.onCreated.addListener(tab => created.push(tab.id));
      });
      await warm.source.goto("https://x.com/bench-feed");
      await until(() => warm.source.getByText(/X limited lookups/i).isVisible(), "restart retains server cooldown");
      assert.ok(await warm.source.locator("#queue1").isHidden());
      assert.deepEqual(await warm.observer.evaluate(() => created), []);
      assert.deepEqual(visits.map(v => v.name), ["slow429"]);
    }
  } else if (scenario === "queue") {
    await feed(Array.from({length: 12}, (_, i) => "queue" + (i + 1)));
    const start = Date.now();
    await enabled(true);
    await until(() => source.locator("#queue1").isVisible(), "first eligible", 10_000);
    const first = Date.now() - start;
    await until(() => source.locator("#queue12").isVisible(), "first 12 resolved", 60_000);
    await source.evaluate(html => {
      document.querySelector("#queue12").style.height = "2000px";
      document.querySelector("section").insertAdjacentHTML("beforeend", html);
    }, post("queue13") + post("queue13", "duplicate") + post("queue14"));
    await source.waitForTimeout(4300);
    const offscreenVisits = visits.filter(v => v.name === "queue13").length;
    await source.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await until(() => source.locator("#queue14").isVisible(), "scroll continues beyond 12 without popup", 13_000);
    assert.equal(offscreenVisits, 0, "unseen distant authors should wait for demand");
    assert.equal(visits.filter(v => v.name === "queue13").length, 1);
    console.log("first eligible", first, "ms; visits from enable", visits.map(v => [v.name, v.time - start]));
  }
  else throw new Error("Unknown review scenario " + scenario);
  console.log("PASS review", scenario);
};

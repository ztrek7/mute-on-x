// Run with a fresh unpacked extension and exclusively routed, offline X pages.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const https = require("node:https");
const { X509Certificate, createHash } = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const extension = path.resolve(process.env.EXTENSION_DIR || path.join(__dirname, "../extension"));
const { serveFilters, testFilters } = require("./filters.cjs");
const nativeMenu = process.argv.includes("--native-menu");

async function run() {
  const html = await fs.readFile(path.join(__dirname, "x.html"), "utf8");
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "mute-on-x-"));
  let context;
  let server, mode, words, saves, loads;
  const hits = [];
  const visits = [];
  const gates = new Map();
  function pauseAt(stage) {
    let release, arrived;
    const wait = new Promise(resolve => { release = resolve; });
    const seen = new Promise(resolve => { arrived = resolve; });
    gates.set(stage, { wait, arrived });
    return { release, seen };
  }
  async function reach(stage) {
    const gate = gates.get(stage);
    if (!gate) return;
    gates.delete(stage);
    gate.arrived();
    await gate.wait;
  }
  function reset(scenario, entries = []) {
    mode = scenario;
    words = entries;
    saves = [];
    loads = 0;
  }
  try {
    reset("success");
    // Map x.com to a private HTTPS fixture, including first loads and redirects.
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-subj", "/CN=x.com", "-addext", "subjectAltName=DNS:x.com,DNS:api.x.com", "-days", "1",
      "-keyout", "key.pem", "-out", "cert.pem"], { cwd: profile, stdio: "ignore" });
    const cert = await fs.readFile(path.join(profile, "cert.pem"));
    const key = await fs.readFile(path.join(profile, "key.pem"));
    const spki = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
    const fingerprint = createHash("sha256").update(spki).digest("base64");
    server = https.createServer({ cert, key }, async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      if (require("./account.cjs").serve(request, response, visits, hits)) return;
      response.setHeader("Set-Cookie", "ct0=fixture-only; Domain=x.com; Path=/; Secure; SameSite=Strict");
      if (require("./review.cjs").serveReview(request, response, visits)) return;
      if (serveFilters(request, response, hits)) return;
      if (request.url === "/fixture/state") {
        return response.end(JSON.stringify({ mode, words }));
      }
      if (request.url === "/fixture/save") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const data = JSON.parse(Buffer.concat(chunks));
        saves.push(data);
        await reach("save");
        if (mode === "success") words.push(data.term);
        return response.end("{}");
      }
      if (request.url === "/settings/muted_keywords") {
        loads++;
        if (loads === 2) await reach("verify");
        if (mode === "login") {
          response.writeHead(302, { location: "/i/jf/onboarding/web?mode=login" });
          return response.end();
        }
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    });
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    // Brave Origin on Linux asks about its free tier on every fresh profile.
    await fs.writeFile(path.join(profile, "Local State"), JSON.stringify({
      brave: { origin: { free_tier_accepted: true } }
    }));
    const launch = () => chromium.launchPersistentContext(profile, {
      executablePath: process.env.BROWSER_BIN || chromium.executablePath(),
      locale: "en-US",
      headless: !nativeMenu,
      ignoreDefaultArgs: ["--disable-extensions", "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
      env: Object.fromEntries(["PATH", "LANG", "DISPLAY", "XAUTHORITY"].filter(k => process.env[k])
        .map(k => [k, process.env[k]]).concat([["HOME", profile], ["XDG_CONFIG_HOME", profile]])),
      args: ["--lang=en-US", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "--no-proxy-server", "--disable-background-networking", "--disable-quic",
        `--ignore-certificate-errors-spki-list=${fingerprint}`,
        `--host-resolver-rules=MAP x.com 127.0.0.1:${server.address().port}, MAP api.x.com 127.0.0.1:${server.address().port}, MAP * ~NOTFOUND`]
    });
    context = await launch();
    const source = await context.newPage();
    await source.goto("https://x.com/home");
    let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 8000 });
    const tab = await worker.evaluate(async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { id: active.id, windowId: active.windowId };
    });
    const observer = context.pages().find(page => page !== source);
    await observer.goto(new URL("/launch.html", worker.url()).href);
    await observer.evaluate(() => {
      document.title = "Fixture observer";
      window.events = [];
      chrome.tabs.onCreated.addListener(t => events.push({ type: "create", id: t.id, active: t.active, win: t.windowId }));
      chrome.tabs.onRemoved.addListener(id => events.push({ type: "remove", id }));
      chrome.tabs.onActivated.addListener(t => events.push({ type: "activate", id: t.tabId }));
      chrome.windows.onFocusChanged.addListener(id => events.push({ type: "focus", id }));
    });
    const clearEvents = () => observer.evaluate(() => { events.length = 0; });
    const readEvents = () => observer.evaluate(() => events);
    const foreground = () => observer.evaluate(async () => {
      const win = await chrome.windows.getLastFocused();
      const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
      return [win.id, active.id];
    });
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function until(check, message, timeout = 8000) {
      const end = Date.now() + timeout;
      do {
        const result = await check();
        if (result) return result;
        await delay(60);
      } while (Date.now() < end);
      assert.fail(message);
    }
    async function assertCleanup(count = 1, allowedActivations = []) {
      const events = await readEvents();
      const created = events.filter(e => e.type === "create");
      assert.equal(created.length, count, JSON.stringify(events));
      assert.ok(created.every(e => !e.active && e.win === tab.windowId), JSON.stringify(events));
      assert.deepEqual(events.filter(e => e.type === "remove").map(e => e.id).sort(),
        created.map(e => e.id).sort(), JSON.stringify(events));
      assert.deepEqual(events.filter(e => e.type === "activate").map(e => e.id), allowedActivations, JSON.stringify(events));
    }
    const observerId = await observer.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    async function click(selector, position) {
      await source.bringToFront();
      await source.locator(selector).click({ button: "right", position });
    }
    // Headless has no browser-chrome menu. Dispatch its documented payload to
    // the registered handler, retaining the real trusted pointer event and tab APIs.
    const dispatch = selectionText => worker.evaluate(({ tab, selectionText }) =>
      handleMenu({ menuItemId: "mute-on-x", pageUrl: "https://x.com/home", frameId: 0, selectionText }, tab),
      { tab, selectionText });
    async function expectMessage(page, expected) {
      const cdp = await context.newCDPSession(page);
      const deadline = Date.now() + 22_000;
      try {
        do {
          const { nodes } = await cdp.send("Accessibility.getFullAXTree");
          if (nodes.some(n => n.role.value === "StaticText" && n.name.value.includes(expected))) {
            const close = nodes.find(n => n.role.value === "button" && n.name.value === "Close");
            assert.ok(close, "dismissible source feedback");
            const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: close.backendDOMNodeId });
            await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function() { this.click(); }" });
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 120));
        } while (Date.now() < deadline);
        console.error({ pages: context.pages().map(p => p.url()), saves, words, loads, events: await readEvents(),
          jobs: await observer.evaluate(() => chrome.storage.session.get(null)),
          foreground: await foreground(), visibility: await page.evaluate(() => document.visibilityState) });
        assert.fail(`Missing feedback "${expected}" on ${page.url()}`);
      } finally {
        await cdp.detach();
      }
    }
    async function action(expected, selectionText, native = false) {
      async function choose() {
        if (native && nativeMenu) {
          execFileSync("python3", [path.join(__dirname, "native_menu.py")], { stdio: "inherit" });
        } else {
          if (nativeMenu) await source.keyboard.press("Escape");
          await dispatch(selectionText);
        }
      }
      await clearEvents();
      assert.deepEqual(await foreground(), [tab.windowId, tab.id]);
      await choose();
      await expectMessage(source, expected);
      assert.equal(source.url(), "https://x.com/home");
      assert.deepEqual(await foreground(), [tab.windowId, tab.id]);
      await assertCleanup();
      assert.deepEqual((await readEvents()).filter(e => e.type === "focus"), []);
    }

    async function checkFilters() {
      await observer.evaluate(() => chrome.storage.local.set({hideUnverified:true}));
      await require("./layout.cjs").testLayout({ source, observer, until });
      await observer.evaluate(() => Promise.all([chrome.storage.session.remove("feedLocationCache"),chrome.storage.local.remove(["feedVerifiedLocations","feedRequestCooldown"])]));
      hits.length = 0;
      await testFilters({ source, observer, worker, hits, until });
      const popupUrl = observer.url();
      await context.close();
      context = await launch();
      const popup = await context.newPage();
      await popup.goto(popupUrl);
      await until(async () => await popup.locator("#usOnly").isChecked() && await popup.locator("#hideNonEnglish").isChecked(),
        "both persisted through full isolated Brave restart");
      console.log("PASS persistent popup switches across a full Brave Origin restart");
    }
    const review = process.argv.find(arg => arg.startsWith("--review="));
    if (review) {
      const restart = async () => {
        const observerUrl=observer.url();
        await context.close();
        context=await launch();
        const warmObserver=context.pages()[0];
        await warmObserver.goto(observerUrl);
        const warmSource=await context.newPage();
        return {source:warmSource,observer:warmObserver};
      };
      await require("./review.cjs").runReview({source,observer,until,visits,restart},review.split("=")[1]);
      return;
    }
    if (process.argv.includes("--layout-only")) {
      await observer.evaluate(() => chrome.storage.local.set({hideUnverified:true}));
      await require("./layout.cjs").testLayout({ source, observer, until });
      return;
    }
    if (process.argv.includes("--filters-only")) {
      await checkFilters();
      return;
    }
    if (nativeMenu) {
      const cdp = await context.newCDPSession(observer);
      const targets = async () => (await cdp.send("Target.getTargets")).targetInfos;
      const current = (await targets()).find(t => t.type === "service_worker" && t.url === worker.url());
      assert.ok(current);
      await cdp.send("Target.closeTarget", { targetId: current.targetId });
      await until(async () => !(await targets()).some(t => t.type === "service_worker" && t.url === worker.url()), "worker is stopped before real menu click");
      await cdp.detach();
    }
    assert.equal(await source.evaluate(() => getSelection().toString()), "");
    await click("#word");
    await action("Confirmed “nebula”", undefined, true);
    if (nativeMenu) {
      worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 8000 });
      console.log("PASS real menu click wakes a stopped worker");
    }
    assert.deepEqual(saves, [{ term: "nebula", checks: [true, false], duration: "7 days" }]);
    assert.equal(loads, 2);
    console.log("PASS unselected word, saved once, defaults preserved, reloaded list, original timeline");

    async function selectPhrase() {
      await source.evaluate(() => {
        const range = new Range();
        range.selectNodeContents(document.querySelector("#phrase"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
    }
    reset("success");
    await selectPhrase();
    await click("#phrase");
    await action("Confirmed “blue mountains”", "blue mountains", true);
    assert.deepEqual(words, ["blue mountains"]);
    console.log("PASS selected phrase");

    const literal = "Keep <draft> & [review] as written";
    reset("success");
    await source.locator("#phrase").evaluate((el, value) => { el.textContent = value; }, literal);
    await selectPhrase();
    await click("#phrase");
    await action("Confirmed “" + literal + "”", literal);
    assert.deepEqual(words, [literal]);
    await source.locator("#phrase").evaluate(el => { el.textContent = "blue mountains"; });
    console.log("PASS instruction-like text with markup characters saved once as a literal phrase");

    reset("success", ["NEBULA"]);
    await selectPhrase();
    await click("#word");
    await action("already in your muted words", "blue mountains");
    assert.equal(saves.length, 0);
    console.log("PASS stale selection elsewhere and case-insensitive duplicate");

    reset("success", ["nebula"]);
    await click("#duration");
    await action("Confirmed “Forever”");
    assert.equal(saves.length, 1);
    assert.deepEqual(words, ["nebula", "Forever"]);
    console.log("PASS duration metadata does not count as a matching word");

    await click("#blank", { x: 400, y: 5 });
    await dispatch();
    await expectMessage(source, "Right-click directly");
    await click("#word");
    await source.reload();
    await dispatch();
    await expectMessage(source, "Right-click directly");
    console.log("PASS whitespace and navigation invalidate capture");

    for (const [scenario, expected, attempts] of [
      ["reject", "X reported a problem saving the word.", 1],
      ["optimistic", "Couldn’t find “nebula” in the reloaded", 1],
      ["changed", "Couldn’t find X’s Add muted word form", 0],
      ["login", "Sign in to X, then right-click", 0]
    ]) {
      reset(scenario);
      await click("#word");
      await action(expected);
      assert.equal(saves.length, attempts);
      assert.deepEqual(words, []);
      console.log(`PASS ${scenario}`);
    }

    async function invoke() {
      if (nativeMenu) await source.keyboard.press("Escape");
      await dispatch();
    }
    reset("success");
    const first = pauseAt("save");
    await click("#word");
    await clearEvents();
    await invoke();
    await first.seen;
    await click("#word");
    await invoke();
    await until(async () => (await readEvents()).filter(e => e.type === "create").length === 2,
      "two independent requests");
    first.release();
    await expectMessage(source, "Confirmed “nebula”");
    await expectMessage(source, "already in your muted words");
    await assertCleanup(2);
    assert.equal(saves.length, 1);
    console.log("PASS overlapping requests, both results delivered, one native save");

    // A second real browser window and a different tab in the original
    // window model the user choosing somewhere else to work mid-save.
    const other = await observer.evaluate(async () => {
      const win = await chrome.windows.create({ url: "about:blank", focused: true });
      return { windowId: win.id, id: win.tabs[0].id };
    });
    await observer.evaluate(id => chrome.windows.update(id, { focused: true }), tab.windowId);
    await source.bringToFront();
    reset("reject");
    const pending = pauseAt("save");
    await click("#word");
    await clearEvents();
    await invoke();
    await pending.seen;
    await observer.evaluate(id => chrome.tabs.update(id, { active: true }), observerId);
    await observer.evaluate(id => chrome.windows.update(id, { focused: true }), other.windowId);
    await until(async () => (await foreground())[0] === other.windowId, "fixture window takes focus");
    const beforeClose = (await readEvents()).length;
    pending.release();
    await until(async () => (await readEvents()).some(e => e.type === "remove"), "failure cleanup");
    assert.deepEqual(await foreground(), [other.windowId, other.id]);
    assert.deepEqual((await readEvents()).slice(beforeClose).map(e => e.type), ["remove"]);
    await assertCleanup(1, [observerId]);
    const [stillActive] = await observer.evaluate(windowId => chrome.tabs.query({ active: true, windowId }), tab.windowId);
    assert.equal(stillActive.id, observerId);
    await observer.evaluate(id => chrome.windows.update(id, { focused: true }), tab.windowId);
    await source.bringToFront();
    await expectMessage(source, "X reported a problem saving the word.");
    await observer.evaluate(id => chrome.windows.remove(id), other.windowId);
    console.log("PASS user-selected tab and other focused window kept through failure and close");

    reset("success");
    const verification = pauseAt("verify");
    await click("#word");
    await clearEvents();
    await invoke();
    await verification.seen;
    await observer.evaluate(id => chrome.tabs.update(id, { active: true }), observerId);
    assert.deepEqual(await foreground(), [tab.windowId, observerId]);
    verification.release();
    await until(async () => (await readEvents()).some(e => e.type === "remove"), "verified tab closes");
    assert.deepEqual(await foreground(), [tab.windowId, observerId]);
    await assertCleanup(1, [observerId]);
    await source.bringToFront();
    await expectMessage(source, "Confirmed “nebula”");
    console.log("PASS tab switch during fresh verification and success cleanup");

    reset("success");
    const adopted = pauseAt("save");
    await click("#word");
    await clearEvents();
    await invoke();
    await adopted.seen;
    const helperId = (await readEvents()).find(e => e.type === "create").id;
    await observer.evaluate(id => chrome.tabs.update(id, { active: true }), helperId);
    adopted.release();
    await until(async () => !(await observer.evaluate(() => chrome.alarms.getAll())).length, "user took over helper");
    assert.deepEqual(await foreground(), [tab.windowId, helperId]);
    await source.bringToFront();
    await expectMessage(source, "You opened or moved the temporary tab");
    assert.ok(await observer.evaluate(id => chrome.tabs.get(id), helperId));
    await observer.evaluate(id => chrome.tabs.remove(id), helperId);
    console.log("PASS explicitly selected helper handed to user");

    reset("success");
    const navigation = pauseAt("save");
    await click("#word");
    await clearEvents();
    await invoke();
    await navigation.seen;
    await source.reload();
    navigation.release();
    await until(async () => (await readEvents()).some(e => e.type === "remove"), "helper cleaned after source reload");
    assert.equal(await source.locator("aside").count(), 0);
    await assertCleanup();
    console.log("PASS replaced source document receives no stale notice or fallback tab");

    reset("success");
    const interrupted = pauseAt("save");
    await click("#word");
    await clearEvents();
    await invoke();
    await interrupted.seen;
    const cdp = await context.newCDPSession(observer);
    const targets = async () => (await cdp.send("Target.getTargets")).targetInfos;
    const oldWorker = (await targets()).find(t => t.type === "service_worker" && t.url === worker.url());
    assert.ok(oldWorker);
    await cdp.send("Target.closeTarget", { targetId: oldWorker.targetId });
    await until(async () => !(await targets()).some(t => t.targetId === oldWorker.targetId), "old worker stopped");
    interrupted.release();
    await until(async () => (await readEvents()).some(e => e.type === "remove"), "alarm wakes a new worker and cleans up", 65_000);
    await expectMessage(source, "Mute on X was interrupted");
    assert.equal(saves.length, 1);
    await assertCleanup();
    assert.deepEqual(await foreground(), [tab.windowId, tab.id]);
    assert.deepEqual(await observer.evaluate(() => chrome.storage.session.get(null)), {});
    assert.deepEqual(await observer.evaluate(() => chrome.alarms.getAll()), []);
    console.log("PASS forced worker termination after Save, automatic cleanup, no replay or false success");

    // Pause only the ownership write in this disposable worker. Terminating it
    // here exercises the narrow gap after real tab creation, before ID storage.
    worker = context.serviceWorkers().find(w => w.url() === oldWorker.url);
    assert.ok(worker);
    await worker.evaluate(() => {
      const write = chrome.storage.session.set.bind(chrome.storage.session);
      chrome.storage.session.set = items => Object.values(items).some(job => job.helperId != null)
        ? new Promise(() => {}) : write(items);
    });
    reset("success");
    await click("#word");
    await clearEvents();
    const dispatching = invoke().catch(() => {}); // The test stops this worker mid-handler.
    const unbound = await until(async () => (await readEvents()).find(e => e.type === "create"), "temporary tab created");
    await until(async () => observer.evaluate(async id => {
      const pages = await chrome.runtime.getContexts({ contextTypes: ["TAB"], tabIds: [id] });
      return pages.some(p => new URL(p.documentUrl).pathname === "/launch.html");
    }, unbound.id), "private launch document loaded");
    const [pendingJob] = Object.values(await observer.evaluate(() => chrome.storage.session.get(null)));
    assert.equal(pendingJob.helperId, undefined);
    const unboundWorker = (await targets()).find(t => t.type === "service_worker" && t.url === worker.url());
    await cdp.send("Target.closeTarget", { targetId: unboundWorker.targetId });
    await until(async () => !(await targets()).some(t => t.targetId === unboundWorker.targetId), "worker stopped before ownership write");
    await dispatching;
    await observer.evaluate(id => chrome.tabs.update(id, { active: true }), observerId);
    await until(async () => (await readEvents()).some(e => e.type === "remove"), "unbound launch cleaned", 65_000);
    await assertCleanup(1, [observerId]);
    assert.deepEqual(await foreground(), [tab.windowId, observerId]);
    assert.equal(saves.length, 0);
    await source.bringToFront();
    await expectMessage(source, "Mute on X was interrupted");
    await cdp.detach();
    console.log("PASS early interruption closes only the request-specific private launch tab");
    await checkFilters();
  } finally {
    try { await context?.close(); }
    finally {
      server?.close();
      await fs.rm(profile, { recursive: true, force: true });
    }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

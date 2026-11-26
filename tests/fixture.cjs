// Run with a fresh unpacked extension and exclusively routed, offline X pages.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const http2 = require("node:http2");
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
    server = http2.createSecureServer({ cert, key }, async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      if (require("./account.cjs").serve(request, response, visits, hits)) return;
      if (require("./review.cjs").serveReview(request, response, visits)) return;
      if (serveFilters(request, response, hits)) return;
      if (request.url === "/settings/add_muted_keyword" && mode === "ssr-404") {
        response.setHeader("Content-Type", "text/html");
        return response.end('<script defer src="/fixture/hydrate.js"></script><input name="keyword"><button disabled>Save</button>');
      }
      if (request.url === "/fixture/hydrate.js") {
        await new Promise(resolve => setTimeout(resolve, 140));
        response.setHeader("Content-Type", "application/javascript");
        return response.end(`const f = document.querySelector("input"), b = document.querySelector("button");
          f.oninput = () => { b.disabled = !f.value; };
          b.onclick = () => fetch("/fixture/native-save", {method:"POST", body:f.value});`);
      }
      if (request.url === "/fixture/native-save") {
        assert.equal(request.method, "POST");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        words.push(Buffer.concat(chunks).toString());
        saves.push({native: true});
        return response.end();
      }
      const modern = request.headers[":authority"] === "api.x.com";
      const api = (modern ? "" : "/i/api") + "/1.1/mutes/keywords/";
      if (request.url.startsWith(api)) {
        if (modern) {
          assert.equal(request.headers.origin, "https://x.com");
          response.setHeader("Access-Control-Allow-Origin", "https://x.com");
          response.setHeader("Access-Control-Allow-Credentials", "true");
          if (request.method === "OPTIONS") {
            response.setHeader("Access-Control-Allow-Headers", request.headers["access-control-request-headers"]);
            response.setHeader("Access-Control-Allow-Methods", "GET, POST");
            response.writeHead(204); return response.end();
          }
        }
        assert.ok(request.headers.authorization?.startsWith("Bearer "));
        const privateSession = request.headers["x-csrf-token"] === "fixture-private";
        const expectedCookie = privateSession ? "fixture-private" : "fixture-only";
        assert.equal(request.headers["x-csrf-token"], expectedCookie);
        assert.ok(request.headers.cookie?.includes("ct0=" + expectedCookie));
        response.setHeader("Content-Type", "application/json");
        if (request.url === api + "list.json") {
          assert.equal(request.method, "GET");
          loads++;
          if (mode === "changed-session" && loads === 1)
            response.setHeader("Set-Cookie", "ct0=replaced; Domain=x.com; Path=/; Secure; SameSite=Strict");
          if (mode === "list-404" || mode === "ssr-404" || (mode === "readback-404" && loads > 1)) response.writeHead(404);
          if (mode === "list-denied") response.writeHead(403);
          if (mode === "list-limited") response.writeHead(429);
          if (mode === "login") response.writeHead(401);
          if (mode === "bad-list") return response.end("{}");
          if (mode === "verify-fail" && loads === 2) response.writeHead(503);
          return response.end(JSON.stringify({muted_keywords: words.map((keyword, i) => ({keyword, id: String(i+1)}))}));
        }
        assert.equal(request.url, api + "create.json");
        assert.equal(request.method, "POST");
        assert.match(request.headers["content-type"], /^application\/x-www-form-urlencoded/i);
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const params = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
        saves.push({params, modern, privateSession});
        await reach("save");
        if (mode === "create-404") response.writeHead(404);
        if (mode === "timeout") return;
        if (mode === "disconnect") return request.stream.close(http2.constants.NGHTTP2_CANCEL);
        if (mode === "deny" || mode === "rate") response.writeHead(mode === "deny" ? 403 : 429);
        if (mode === "redirect") response.writeHead(302, {location: "https://x.com/rejected"});
        if (mode === "reject") return response.end(JSON.stringify({errors: [{message: "fixture rejection"}]}));
        if (mode === "success" || mode === "list-404") words.push(params.keyword);
        return response.end(JSON.stringify({muted_keywords: [{keyword: params.keyword}]}));
      }
      assert.notEqual(request.url, "/rejected", "mutation redirect must never be followed");
      const fixtureCookie = request.url === "/home?private-mute" ? "fixture-private" : "fixture-only";
      if (request.url === "/home" || request.url === "/home?private-mute")
        response.setHeader("Set-Cookie", "ct0=" + fixtureCookie + "; Domain=x.com; Path=/; Secure; SameSite=Strict");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    });
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    // Brave Origin on Linux asks about its free tier on every fresh profile.
    await fs.writeFile(path.join(profile, "Local State"), JSON.stringify({
      brave: { origin: { free_tier_accepted: true } }
    }));
    const upgrade = process.argv.includes("--review=count-upgrade");
    const installed = upgrade ? path.join(profile, "unpacked-extension") : extension;
    if (upgrade) {
      assert.ok(process.env.PRIOR_EXTENSION_DIR, "set PRIOR_EXTENSION_DIR to an extracted previous ZIP");
      await fs.cp(path.resolve(process.env.PRIOR_EXTENSION_DIR), installed, {recursive:true});
    }
    const launch = () => chromium.launchPersistentContext(profile, {
      executablePath: process.env.BROWSER_BIN || chromium.executablePath(),
      locale: "en-US",
      headless: !nativeMenu,
      ignoreDefaultArgs: ["--disable-extensions", "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
      env: Object.fromEntries(["PATH", "LANG", "DISPLAY", "XAUTHORITY"].filter(k => process.env[k])
        .map(k => [k, process.env[k]]).concat([["HOME", profile], ["XDG_CONFIG_HOME", profile]])),
      args: ["--lang=en-US", `--disable-extensions-except=${installed}`, `--load-extension=${installed}`,
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
    await observer.goto(new URL("/filters.html", worker.url()).href);
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
    let navigations = 0;
    source.on("framenavigated", () => navigations++);
    async function click(selector, position) {
      await source.bringToFront();
      await source.locator(selector).click({ button: "right", position });
    }
    // Headless has no browser-chrome menu. Dispatch its documented payload to
    // the registered handler, retaining the real trusted pointer event and tab APIs.
    const dispatch = selectionText => worker.evaluate(({ tab, selectionText }) => {
      void handleMenu({ menuItemId: "mute-on-x", pageUrl: "https://x.com/home", frameId: 0, selectionText }, tab);
    }, { tab, selectionText });
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
      const before = navigations;
      await choose();
      await expectMessage(source, expected);
      assert.equal(source.url(), "https://x.com/home");
      assert.deepEqual(await foreground(), [tab.windowId, tab.id]);
      assert.equal(navigations, before, "menu must not navigate any frame");
      assert.deepEqual(await readEvents(), [], "menu must not create, remove or activate tabs");
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
    if (upgrade) {
      await require("./count-upgrade.cjs")({source, observer, until, replace:async () => {
        await fs.cp(extension, installed, {recursive:true});
      }});
      return;
    }
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
      const scenario = review.split("=")[1];
      await require("./review.cjs").runReview({source,observer,until,visits,restart}, scenario);
      if (scenario === "private-stats") {
        assert.equal(saves.length, 1);
        assert.equal(saves[0].privateSession, true);
        assert.equal((await context.cookies("https://x.com")).find(c => c.name === "ct0").value, "fixture-only");
        console.log("PASS private mute uses the private session and preserves regular credentials");
      }
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
    // The signed-in web client can load its native form even when the extension's initial GET returns 404.
    async function nativeFormFallback(scenario) {
      reset(scenario);
      await source.locator("#word").evaluate(el => { el.textContent = "BREAKING"; });
      await click("#word");
      if (nativeMenu) await source.keyboard.press("Escape");
      await dispatch();
      await until(() => context.pages().some(p => p.url() === "https://x.com/settings/add_muted_keyword"),
        "an initial list 404 opens X's native form");
      const form = context.pages().find(p => p.url() === "https://x.com/settings/add_muted_keyword");
      await until(async () => await form.locator('[name="keyword"]').inputValue() === "BREAKING", "literal term prefilled");
      assert.equal(source.url(), "https://x.com/home");
      assert.deepEqual([loads, saves.length], [1, 0]);
      await form.waitForLoadState("domcontentloaded");
      await until(() => form.locator("button").isEnabled(), "X received the prefill after hydration and enabled Save");
      await form.locator("button").click();
      await until(() => words.includes("BREAKING"), "native Save applied the selected term");
      assert.equal(saves.length, 1);
      await form.reload();
      assert.equal(await form.locator('[name="keyword"]').inputValue(), "");
      await form.close();
      await source.bringToFront();
      await source.locator("#word").evaluate(el => { el.textContent = "nebula"; });
      console.log("PASS initial list 404, origin feed preserved, one-use prefill, only native Save writes");
    }
    await nativeFormFallback("list-404");
    await nativeFormFallback("ssr-404");
    if (process.argv.includes("--native-form-only")) return;
    reset("success");
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
    assert.deepEqual(saves, [{modern: false, privateSession: false, params: {keyword: "nebula", mute_surfaces: "notifications,home_timeline,tweet_replies", mute_options: "", duration: ""}}]);
    assert.equal(loads, 2);
    console.log("PASS unselected word, saved once, explicit scopes and duration, fresh list, original timeline");

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
      ["reject", "X reported a problem", 1], ["deny", "X denied access", 1],
      ["rate", "X is rate-limiting", 1], ["redirect", "X denied access", 1],
      ["optimistic", "Save unconfirmed", 1], ["verify-fail", "Save unconfirmed", 1],
      ["disconnect", "Save unconfirmed", 1], ["timeout", "Save unconfirmed", 1],
      ["readback-404", "Save unconfirmed", 1], ["create-404", "Save unconfirmed", 1],
      ["list-denied", "X denied access", 0], ["list-limited", "X is rate-limiting", 0],
      ["bad-list", "Couldn’t verify", 0], ["login", "X requires sign-in", 0]
    ]) {
      reset(scenario);
      await click("#word");
      await action(expected);
      assert.equal(saves.length, attempts);
      assert.deepEqual(words, []);
      console.log("PASS", scenario, "without repeated writes or navigation");
    }

    reset("changed-session");
    await click("#word");
    await action("The X page or session changed");
    assert.equal(saves.length, 0);
    assert.equal(loads, 1);
    console.log("PASS session rotation before save stops the write");

    reset("success");
    await context.clearCookies({name: "ct0"});
    await click("#word");
    await action("Sign in to X");
    assert.equal(saves.length + loads, 0);
    await source.reload();
    console.log("PASS signed-out document sends no requests");

    await source.evaluate(() => {
      document.documentElement.dataset.appVersion = "fixture";
      const link = document.createElement("link");
      link.href = "https://abs.twimg.com/x-web/x-web/fixture.css";
      document.head.append(link);
    });
    await click("#word");
    await action("Confirmed “nebula”");
    assert.equal(saves[0].modern, true);
    assert.equal(loads, 2);
    console.log("PASS modern first-party endpoint, credentialed CORS and verified readback");
    await source.reload();

    reset("success");
    const pending = pauseAt("save");
    await click("#word");
    if (nativeMenu) await source.keyboard.press("Escape");
    await dispatch();
    await pending.seen;
    await click("#word");
    await action("Another mute is in progress");
    pending.release();
    await expectMessage(source, "Confirmed “nebula”");
    assert.equal(saves.length, 1);
    console.log("PASS concurrent requests share one write");
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

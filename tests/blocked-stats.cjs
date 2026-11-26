const assert = require("node:assert/strict");

function post(id, handle = "local", text = "Buenos días a todos.", extra = "") {
  return `<article data-testid="tweet"><a href="/${handle}/status/${id}"><time>Today</time></a><div data-testid="tweetText" lang="${text.startsWith("Buenos") ? "es" : "en"}">${text}</div>${extra}</article>`;
}

module.exports = async function ({source, observer, until, restart}) {
  const popupPath = new URL("/filters.html", observer.url()).href;
  const badge = page => page.evaluate(async () => chrome.action.getBadgeText({tabId:(await chrome.tabs.getCurrent()).id}));
  async function expectCounts(page, current, lifetime) {
    await until(async () => (await badge(page)) === (current > 999 ? "999+" : String(current)) &&
      (await page.locator("#blockedNow").textContent()) === current.toLocaleString("en-US") &&
      (await page.locator("#blockedTotal").textContent()) === lifetime.toLocaleString("en-US"),
    `toolbar and popup should show session ${current}, lifetime ${lifetime}`);
  }
  const mount = (page, html) => page.evaluate(html => {
    document.body.innerHTML = '<a data-testid="AppTabBar_Profile_Link" href="/fixtureviewer">Profile</a><main>' + html + '</main>';
  }, html);
  await observer.goto(popupPath);
  await expectCounts(observer, 0, 0);
  const another = await source.context().newPage();
  await another.goto("https://x.com/home");
  const quote = '<div data-slot="embedded-tweet-frame" data-href="/maple/status/33"><div data-testid="tweetText" lang="es">Buenos días a todos.</div></div>';
  await Promise.all([
    mount(source, post("11") + post("11") + post("12", "local", "An update.", quote)),
    mount(another, post("11") + post("33", "maple"))
  ]);
  await observer.locator("#hideNonEnglish").check();
  await expectCounts(observer, 3, 3);
  // Recycle a node in place, and remount a previously hidden post.
  await source.locator("article").first().evaluate(el => {
    el.querySelector("a").href = "/local/status/14";
  });
  await expectCounts(observer, 4, 4);
  await observer.locator("#hideNonEnglish").uncheck();
  await until(() => source.locator("article").first().isVisible(), "filters toggled off");
  await mount(source, post("12") + post("14"));
  await observer.locator("#hideNonEnglish").check();
  await until(() => source.locator("article").first().isHidden(), "posts hidden again");
  await expectCounts(observer, 4, 4);
  const cdp = await source.context().newCDPSession(observer);
  const worker = (await cdp.send("Target.getTargets")).targetInfos.find(t => t.type === "service_worker");
  await cdp.send("Target.closeTarget", {targetId:worker.targetId});
  await until(async () => !(await cdp.send("Target.getTargets")).targetInfos.some(t => t.targetId === worker.targetId), "worker stopped");
  await mount(source, post("12") + post("15"));
  await expectCounts(observer, 5, 5);
  await cdp.detach();
  // Pending US and unverified authors shouldn't increase the total.
  await mount(source, post("16","slowpanel","An update.") + post("17","missing","An update.") + post("18","maple","An update."));
  await source.bringToFront();
  await observer.evaluate(() => chrome.storage.local.set({usOnly:true, hideUnverified:true}));
  await until(() => source.locator("article").first().isHidden(), "US post waiting for confirmation");
  assert.equal(await badge(observer), "5");
  await until(() => source.locator("article").first().isVisible(), "confirmed US post restored");
  await expectCounts(observer, 6, 6);
  await observer.evaluate(() => chrome.storage.local.set({usOnly:false, hideNonEnglish:false}));
  await another.close();
  await source.goto("about:blank");
  const warm = await restart();
  await expectCounts(warm.observer, 0, 6);
  await warm.source.goto("https://x.com/home");
  await mount(warm.source, post("11"));
  await warm.observer.locator("#hideNonEnglish").check();
  await expectCounts(warm.observer, 1, 7);
  assert.deepEqual(await warm.observer.evaluate(async () => {
    const data = await chrome.storage.local.get(null);
    return Object.keys(data).filter(k => k.startsWith("blocked")).map(k => [k, data[k]]);
  }), [["blockedAllTime", 7]]);
  const translated = '<button aria-label="Show original"></button>';
  await mount(warm.source, Array.from({length:1000}, (_, i) =>
    post(String(i + 100), "local", "An update.", translated)).join(""));
  await expectCounts(warm.observer, 1001, 1007);
  console.log("PASS actual toolbar and popup counts, concurrent tabs, quotes, recycling, filter toggles, worker restart and full Brave restart");
};

module.exports.privateWindow = async function ({source, observer, until}) {
  // Allow the unpacked extension in private windows of the fixture's temporary profile.
  const popupUrl = new URL("/filters.html", observer.url()).href;
  const id = new URL(popupUrl).hostname;
  const prefs = await source.context().newPage();
  await prefs.goto("chrome://extensions");
  await prefs.evaluate(async id => {
    await chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});
    await chrome.developerPrivate.updateExtensionConfiguration({extensionId:id, incognitoAccess:true});
  }, id);
  // Changing incognito access reloads the extension and closes the old observer.
  const popup = await source.context().newPage();
  await until(async () => {
    try { await popup.goto(popupUrl); return true; }
    catch { return false; }
  }, "extension ready after incognito permission change");
  await popup.evaluate(() => chrome.storage.local.set({hideNonEnglish:true}));
  await source.reload();
  await source.evaluate(html => { document.body.innerHTML = "<main>" + html + "</main>"; }, post(51) + post(52) + post(53));
  const regularBadge = () => popup.evaluate(async () => chrome.action.getBadgeText({tabId:(await chrome.tabs.getCurrent()).id}));
  await until(async () => (await regularBadge()) === "3", "regular count established");
  const cdp = await source.context().newCDPSession(source);
  const targets = async () => (await cdp.send("Target.getTargets")).targetInfos;
  const regularContext = (await targets()).find(t => t.url === popupUrl).browserContextId;

  // Observe the real popup in the disposable private browser context. Its tab
  // IDs and toolbar overrides are inaccessible from the regular extension page.
  async function openPrivate() {
    await popup.evaluate(url => chrome.windows.create({incognito:true, url}), popupUrl);
    const target = await until(async () => (await targets()).find(t =>
      t.type === "page" && t.url === popupUrl && t.browserContextId !== regularContext), "private popup opened");
    const {sessionId} = await cdp.send("Target.attachToTarget", {targetId:target.targetId});
    let seq = 0;
    async function evaluate(fn, arg) {
      const id = ++seq;
      const response = new Promise((resolve, reject) => {
        function receive(event) {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message);
          if (message.id !== id) return;
          cdp.off("Target.receivedMessageFromTarget", receive);
          if (message.error || message.result.exceptionDetails) reject(Error(JSON.stringify(message)));
          else resolve(message.result.result.value);
        }
        cdp.on("Target.receivedMessageFromTarget", receive);
      });
      await cdp.send("Target.sendMessageToTarget", {sessionId, message:JSON.stringify({id,
        method:"Runtime.evaluate", params:{expression:"(" + fn + ")(" + JSON.stringify(arg) + ")",
          awaitPromise:true, returnByValue:true}})});
      return response;
    }
    await until(() => evaluate(() => chrome.extension?.inIncognitoContext === true), "private popup context ready");
    return {evaluate, context:target.browserContextId};
  }
  const privatePage = await openPrivate();
  const readCount = () => document.querySelector("#blockedNow")?.textContent;
  const action = async tabId => [
    await chrome.action.getBadgeText({tabId}),
    await chrome.action.getTitle({tabId})
  ];
  const privateTab = await privatePage.evaluate(async () =>
    (await chrome.tabs.create({url:"https://x.com/fixture/feed"})).id);
  async function checkPrivate(tabId, expected) {
    await until(async () => {
      const [badge, title] = await privatePage.evaluate(action, tabId);
      return badge === String(expected) && title === "Mute on X · " + expected + " blocked this session";
    }, "private tab badge and tooltip match " + expected);
  }
  await until(async () => (await privatePage.evaluate(readCount)) === "2", "two private blocks in popup");
  await checkPrivate(privateTab, 2);
  const worker = (await targets()).find(t => t.type === "service_worker" && t.browserContextId === privatePage.context);
  await cdp.send("Target.closeTarget", {targetId:worker.targetId});
  await until(async () => !(await targets()).some(t => t.targetId === worker.targetId), "private worker stopped");
  assert.equal(await privatePage.evaluate(() => chrome.runtime.sendMessage({type:"private-block-count"})), 2);
  async function navigate(url) {
    await privatePage.evaluate(({tabId,url}) => chrome.tabs.update(tabId,{url}), {tabId:privateTab,url});
    await until(() => privatePage.evaluate(async tabId =>
      (await chrome.tabs.get(tabId)).status === "complete", privateTab), "private navigation complete");
    await checkPrivate(privateTab, 2);
  }
  await navigate("https://x.com/home");
  await navigate("https://x.com/fixture/feed");
  await privatePage.evaluate(id => chrome.tabs.reload(id), privateTab);
  await until(() => privatePage.evaluate(async id => (await chrome.tabs.get(id)).status === "complete", privateTab), "reload complete");
  await checkPrivate(privateTab, 2);
  const second = await privatePage.evaluate(async () =>
    (await chrome.windows.create({incognito:true,url:"https://x.com/home"})).tabs[0].id);
  await checkPrivate(second, 2);
  await source.evaluate(html => document.querySelector("main").insertAdjacentHTML("beforeend",html),post(54));
  await until(async () => (await regularBadge()) === "4", "four regular blocks");
  assert.equal(await popup.evaluate(() => chrome.action.getBadgeText({})), "", "neutral default during navigation");
  await checkPrivate(second, 2);
  await checkPrivate(privateTab, 2);
  await privatePage.evaluate(id => chrome.tabs.remove(id), second);
  await checkPrivate(privateTab, 2);
  const sharedKeys = () => popup.evaluate(async () => (await chrome.storage.session.getKeys()).filter(k => k.startsWith("blockedPrivate")));
  assert.deepEqual(await sharedKeys(), []);
  for (const t of await targets()) {
    if (t.type === "page" && t.browserContextId === privatePage.context)
      await cdp.send("Target.closeTarget",{targetId:t.targetId});
  }
  await until(async () => !(await targets()).some(t => t.browserContextId === privatePage.context), "last private window and worker closed");
  const fresh = await openPrivate();
  await until(async () => (await fresh.evaluate(readCount)) === "0", "new private session starts empty");
  await fresh.evaluate(() => chrome.tabs.create({url:"https://x.com/fixture/feed"}));
  await until(async () => (await fresh.evaluate(readCount)) === "2", "same posts counted anew in next private session");
  assert.equal(await regularBadge(), "4");
  assert.deepEqual(await popup.evaluate(() => chrome.storage.local.get("blockedAllTime")), {blockedAllTime:4});
  assert.deepEqual(await sharedKeys(), []);
  await cdp.detach();
  console.log("PASS private badges, tooltip and popup through navigation, reload, multiple windows and last-window closure");
};

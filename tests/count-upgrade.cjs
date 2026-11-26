const assert = require("node:assert/strict");

module.exports = async function ({source, observer, until, replace}) {
  const old = await observer.evaluate(() => ({id:chrome.runtime.id, version:chrome.runtime.getManifest().version}));
  const url = observer.url();
  const tab = await observer.evaluate(async () => (await chrome.tabs.query({active:true, currentWindow:true}))[0].id);
  const counts = (popup, session, total) => until(() => popup.evaluate(async ({tab,session,total}) =>
    await chrome.action.getBadgeText({tabId:tab}) === String(session) &&
    document.querySelector("#blockedNow")?.textContent === String(session) &&
    document.querySelector("#blockedTotal")?.textContent === String(total) &&
    (await chrome.storage.local.get("blockedAllTime")).blockedAllTime === total,
  {tab,session,total}), "upgraded badge, popup and persistent aggregate");
  await observer.evaluate(() => chrome.storage.local.set({hideNonEnglish:true,hideUnverified:true}));
  await source.evaluate(() => {
    document.querySelector("main").innerHTML = Array.from({length:9}, (_,i) =>
      '<article data-testid="tweet"><a href="/sample/status/' + (21+i) + '"><time>Today</time></a>' +
      '<div data-testid="tweetText" lang="es">Buenos días a todos.</div></article>').join("");
  });
  await counts(observer, 9, 9);
  const manager = await source.context().newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}));
  await replace(); // Same disposable unpacked directory, as in the published update instructions.
  await manager.evaluate(id => chrome.developerPrivate.reload(id, {failQuietly:true}), old.id);
  const popup = await source.context().newPage();
  await until(async () => {
    try {
      await popup.goto(url);
      return await popup.evaluate(old => chrome.runtime.id === old.id &&
        chrome.runtime.getManifest().version !== old.version, old);
    } catch { return false; } // Reload can still be invalidating the old extension pages.
  }, "new version active under the original extension ID");
  const version = await popup.evaluate(() => chrome.runtime.getManifest().version);
  await counts(popup, 0, 9);
  assert.deepEqual(await popup.evaluate(() => chrome.storage.local.get(["hideNonEnglish","hideUnverified"])),
    {hideNonEnglish:true,hideUnverified:true});
  const stalePost = id => source.evaluate(id => {
    document.querySelector("main").innerHTML = '<article data-testid="tweet"><a href="/sample/status/' + id +
      '"><time>Today</time></a><div data-testid="tweetText" lang="es">Buenos días a todos.</div></article>';
  }, id);
  await source.bringToFront();
  await popup.reload(); // Read the status of the existing X tab.
  await stalePost(80);
  if (["1.7.0","1.8.0"].includes(old.version))
    await until(() => source.locator("article").isHidden(), "prior release still hides from stale document");
  await counts(popup, 0, 9);
  const refreshHint = page => page.getByText(/refresh.*x.com tab/i).isVisible();
  await until(() => refreshHint(popup), "popup explains how to recover a stale X tab");
  await source.reload();
  await source.evaluate(() => {
    document.querySelector("main").innerHTML = '<div data-href="/sample/status/21"><article data-testid="tweet">' +
      '<div data-testid="tweetText" lang="es">Buenos días a todos.</div></article></div>';
  });
  await until(() => source.locator("article").isHidden(), "matching post hidden using retained preference");
  await counts(popup, 1, 10);
  await until(async () => !await refreshHint(popup), "connected tab clears refresh guidance");
  await manager.evaluate(id => chrome.developerPrivate.reload(id, {failQuietly:true}), old.id);
  await source.locator("main").evaluate(main => main.insertAdjacentHTML("beforeend",
    '<article data-testid="tweet"><a href="/sample/status/81"><time>Today</time></a>' +
    '<div data-testid="tweetText" lang="es">Buenos días a todos.</div></article>'));
  await until(() => source.locator("article").evaluateAll(rows => rows.length === 2 &&
    rows.every(el => el.getClientRects().length)), "old row restored and new row visible after patched reload");
  await until(() => source.locator("style").evaluateAll(styles => styles.every(el =>
    !el.textContent.includes("[data-mox-hide]"))), "disconnected content script removed its layout rules");
  const latestPopup = await source.context().newPage();
  await latestPopup.goto(url);
  await counts(latestPopup, 0, 10);
  console.log("PASS same-directory upgrade", old.version, "to", version, "retained prior 9, reset session and counted new hide");
};

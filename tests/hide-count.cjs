const assert = require("node:assert/strict");

const quote = '<div data-slot="embedded-tweet-frame" data-href="/quoted/status/888"><article><a href="/quoted/status/888"><time>Today</time></a></article></div>';
const text = '<div data-testid="tweetText" lang="es">Buenos días a todos.</div>';
const article = (body = text) => '<article data-testid="tweet">' + body + '</article>';
const overlay = id => '<a aria-hidden="true" tabindex="-1" href="/sample/status/' + id + '"></a>';
const cell = contents => '<div data-testid="cellInnerDiv">' + contents + '</div>';

module.exports = async function ({source, observer, until}, scenario) {
  const main = source.locator("main");
  const mount = html => main.evaluate((el, markup) => { el.innerHTML = markup; }, html);
  await observer.goto(new URL("/filters.html", observer.url()).href);
  await source.bringToFront();
  const tabId = await observer.evaluate(async () => (await chrome.tabs.query({active:true, currentWindow:true}))[0].id);
  async function expectCount(value) {
    const read = () => observer.evaluate(async tabId => [
      await chrome.action.getBadgeText({tabId}),
      document.querySelector("#blockedNow").textContent,
      document.querySelector("#blockedTotal").textContent,
      String((await chrome.storage.local.get("blockedAllTime")).blockedAllTime || 0)
    ], tabId);
    const expected = Array(4).fill(String(value)).join();
    await until(async () => (await read()).join() === expected, "badge, session, total and stored total should equal " + value);
  }
  await expectCount(0);
  if (scenario === "count-location") {
    const locationPost = (handle, id) => cell(article('<a href="/' + handle + '/status/' + id +
      '"><time>Today</time></a><div data-testid="tweetText" lang="en">A quiet afternoon.</div>'));
    await mount(locationPost("missing", "700"));
    await observer.evaluate(() => chrome.storage.local.set({usOnly:true, hideUnverified:true}));
    const result = handle => observer.evaluate(async name =>
      (await chrome.storage.session.get("feedLocationCache")).feedLocationCache?.entries?.[name], handle);
    await until(async () => (await result("missing"))?.reason === "unknown", "X returned a completed lookup with no location label");
    assert.ok(await main.locator("article").isHidden());
    await expectCount(1);
    await mount(locationPost("slowpanel", "720"));
    await until(() => main.locator("article").isHidden(), "pending US lookup temporarily collapses the row");
    await expectCount(1);
    await until(() => main.locator("article").isVisible(), "delayed US response restores the row");
    await mount(locationPost("cutjson", "721"));
    await until(async () => (await result("cutjson"))?.reason === "unavailable", "temporary service failure");
    assert.ok(await main.locator("article").isHidden());
    await mount(locationPost("maple", "722"));
    await expectCount(2);
    assert.ok(await main.locator("article").isHidden());
    assert.deepEqual(await observer.evaluate(async () => {
      const stored = await chrome.storage.session.get(["blockedSession:20","blockedSession:21","blockedSession:22"]);
      return Object.values(stored);
    }), ["722"]);
    console.log("PASS strict missing label and confirmed non-US counted, pending US and temporary failure excluded");
    return;
  }

  await observer.evaluate(() => chrome.storage.local.set({hideNonEnglish:true}));
  await mount(cell(article(text + quote)));
  if (scenario === "count-links") {
    const timestamp = '<a href="/sample/status/731"><time>Today</time></a>';
    const sourceLink = '<div><a href="/creator/status/900">From @creator</a></div>';
    const byline = '<div data-testid="User-Name"><a href="/sample"><span>@sample</span></a></div>';
    const media = (who, id, type) => '<a href="/' + who + '/status/' + id + '/' + type + '/1">' +
      '<div data-testid="' + (type === "photo" ? "tweetPhoto" : "videoPlayer") + '"><img alt=""></div></a>';
    await mount(cell(article(timestamp + text + sourceLink + '<div data-testid="birdwatch-pivot"><a href="/notes/status/901">Read a note</a></div>')) +
      cell(article(byline + text + media("sample", "732", "photo"))) +
      cell(article(byline + text + media("sample", "733", "video"))) +
      cell(article(byline + text + media("creator", "950", "photo"))) +
      cell(article(byline + text + '<div>From <a href="/creator/status/953">@creator</a></div>')) +
      cell(article(byline + text + '<div data-testid="quoteTweet">' + media("sample", "951", "photo") + '</div>')) +
      cell(article(byline + text + '<a href="/sample/status/952/analytics">Views</a>')));
    await until(() => main.locator("article").evaluateAll(rows => rows.every(el => !el.getClientRects().length)), "matching rows hidden");
    await expectCount(3);
    const keys = await observer.evaluate(async () => Object.entries(await chrome.storage.session.get(null))
      .filter(([key]) => key.startsWith("blockedSession:")).map(([,ids]) => ids).sort());
    assert.deepEqual(keys, ["731","732","733"]);
    console.log("PASS timestamp with secondary links and attributable own photo/video links");
    return;
  }
  const row = main.locator('article[data-testid="tweet"]');
  await until(() => row.isHidden(), "language filter hid the mounted outer post");
  const receipt = ids => observer.evaluate(async ids => {
    const keys = ids.map(id => "blockedSession:" + id.slice(-2));
    const buckets = await chrome.storage.session.get(keys);
    return ids.map((id, i) => (buckets[keys[i]] || "").split(" ").includes(id));
  }, ids);
  // A quote, a naked byline, and a virtual list index cannot identify the outer post.
  assert.deepEqual(await receipt(["888"]), [false]);
  await main.locator("div[data-testid=cellInnerDiv]").evaluate((el, link) => el.insertAdjacentHTML("afterbegin", link), overlay("701"));
  await expectCount(1);
  assert.deepEqual(await receipt(["701","888"]), [true,false]);
  const link = main.locator("div[data-testid=cellInnerDiv] > a");
  await link.evaluate(el => { el.href = "/sample/status/702"; });
  await expectCount(2);
  await link.evaluate(el => { el.href = "/sample/status/701"; });
  await row.evaluate(el => { el.prepend(document.createElement("span")); });
  // An unrelated sibling or an ambiguous pair of links cannot identify a post.
  await mount(cell(article(text + quote) + overlay("703") + overlay("704")) +
    cell(article(text + quote)) + cell(article(text) + '<a href="/sample/status/705">Related post</a>') +
    '<div data-href="/sample/status/706">' + article(text + quote) + '</div>');
  await expectCount(3);
  assert.deepEqual(await receipt(["703","704","705","706","888"]), [false,false,false,true,false]);
  await main.locator("[data-href='/sample/status/706']").evaluate(el => { el.dataset.href = "/sample/status/707"; });
  await expectCount(4);
  // A detached or repurposed article has no outstanding count to give its successor.
  await mount(cell(article(text + quote)));
  await until(() => row.isHidden(), "unidentified row hidden immediately");
  await row.evaluate(el => {
    el.innerHTML = '<a href="/sample/status/708"><time>Today</time></a><div data-testid="tweetText" lang="en">The park is open.</div>';
  });
  await until(() => row.isVisible(), "recycled nonmatching post restored");
  // A natively hidden row is countable when the site reveals it to our filter.
  await mount('<div hidden>' + article('<a href="/sample/status/709"><time>Today</time></a>' + text) + '</div>' +
    cell(article('<a href="/sample/status/710"><time>Today</time></a>' + text)));
  await expectCount(5);
  assert.deepEqual(await receipt(["708","709","710"]), [false,false,true]);
  await main.locator("div[hidden]").evaluate(el => { el.hidden = false; });
  await expectCount(6);
  // Separate and overlapping newer filters go through the same worker and UI.
  await observer.evaluate(() => chrome.storage.local.set({hideRepeatedText:true, hideAlertHeadlines:true, hideAllCaps:true}));
  const repeated = Array(3).fill("Check the spare cable.").join("<br>");
  const stylePost = (id, html) => cell(article('<a href="/sample/status/' + id + '"><time>Today</time></a><div data-testid="tweetText" lang="en">' + html + '</div>'));
  await mount(stylePost("711", repeated) + stylePost("712", "News alert: Update.") +
    stylePost("713", "🚨 Update.<br>" + repeated) + stylePost("713", repeated) + stylePost("714", "TAKE A LOOK!"));
  await expectCount(10);
  assert.equal(await row.count(), 5);
  assert.ok(await row.evaluateAll(rows => rows.every(el => !el.getClientRects().length)));
  // Two different plausible outer URLs are unresolved until the row reconciles.
  const inside = '<a href="/sample/status/715"><time>Today</time></a>';
  await mount(cell(article(inside + text + quote) + overlay("716")) + cell(article(text + quote)));
  const first = row.first();
  await until(() => first.isHidden(), "conflicting IDs leave filtering active");
  await row.last().evaluate((el, html) => el.insertAdjacentHTML("afterbegin", html),
    '<a href="/sample/status/717"><time>Today</time></a>');
  await expectCount(11);
  assert.deepEqual(await receipt(["715","716","717","888"]), [false,false,true,false]);
  await main.locator("a[href='/sample/status/716']").evaluate(el => el.remove());
  await expectCount(12);
  assert.deepEqual(await receipt(["715","716"]), [true,false]);
  console.log("PASS outer post identity, three displays, same-session deduplication and native visibility");
};

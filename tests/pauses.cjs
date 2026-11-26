const assert = require("node:assert/strict");

const cases = {
  schema: [["drift"], "response changed"],
  access: [["denied"], "denied access"],
  budget: [["queue1"], "Hourly lookup allowance"],
  limited: [["limited"], "limited lookups"],
  login: [["loginonly"], "sign-in required"],
  unavailable: [["serverfail1", "serverfail2", "serverfail3"], "temporarily unavailable"]
};

exports.run = async ({source, observer, sourceId, until, fill, enabled, state, text, visits, post}, gate) => {
  const hint = source.locator("[data-mox-empty-feed]");
  const scrolls = () => source.evaluate(() => window.syntheticScrolls);
  await source.evaluate(() => {
    window.syntheticScrolls = 0;
    document.addEventListener("scroll", event => {
      if (!event.isTrusted) window.syntheticScrolls++;
    }, true);
  });

  if (gate === "budget-expiry") {
    await fill(["uk"]);
    const release = await observer.evaluate(async () => {
      const at = Date.now()+4000;
      await chrome.storage.local.set({feedRequestTimes:Array(96).fill(at-3600_000)});
      return at;
    });
    await source.evaluate(html => document.addEventListener("scroll", function append(event) {
      if (event.isTrusted) return;
      document.querySelector("section").insertAdjacentHTML("beforeend",html);
      document.removeEventListener("scroll",append);
    }), post("queue1"));
    await enabled(true);
    await until(async () => (await text()).includes("Hourly lookup allowance"), "rolling budget blocked checks");
    await until(() => source.locator("#queue1").isVisible(), "real budget expiry resumed lookup and pagination", 12_000);
    assert.equal(await scrolls(),1);
    assert.deepEqual(visits.map(v => v.name),["uk","queue1"]);
    assert.ok(visits[0].time >= release);
    return;
  }
  if (gate === "expiry") {
    // A language-excluded row needs no lookup, even after the country pause
    // expires. Its unchanged end marker must still become eligible again.
    await fill(["uk"]);
    await source.locator("[data-testid=tweetText]").evaluate(el => el.textContent = "Muchas gracias");
    await observer.evaluate(async () => {
      await chrome.storage.session.set({feedLocationCache: {reason:"schema", pause:Date.now()+3500}});
      await chrome.storage.local.set({hideNonEnglish:true});
    });
    await until(() => source.locator("#uk").isHidden(), "language filter queued end check");
    await enabled(true);
    await until(async () => (await text()).includes("response changed"), "pause cancels queued pagination");
    await source.waitForTimeout(500);
    assert.equal(await scrolls(), 0, "queued scroll cancelled during pause");
    await source.evaluate(html => document.addEventListener("scroll", function append(e) {
      if (!e.isTrusted) {
        document.querySelector("section").insertAdjacentHTML("beforeend",html);
        document.removeEventListener("scroll",append);
      }
    }), post("queue1"));
    await until(() => source.locator("#queue1").isVisible(), "deadline resumes pagination and finds eligible post");
    assert.equal(await scrolls(), 1);
    assert.deepEqual(visits.map(v => v.name), ["queue1"]);
    return;
  }

  const [authors, explanation] = cases[gate];
  if (gate === "budget") await observer.evaluate(() =>
    chrome.storage.local.set({feedRequestTimes:Array(96).fill(Date.now())}));
  await fill(authors);
  await enabled(true);
  await until(async () => (await state())?.reason === gate && (await text()).includes(explanation), "entered " + gate);
  await source.waitForTimeout(550);
  const popup = await text();
  const header = await hint.locator("[role=status]").textContent();
  const evidence = {
    scrolls: await scrolls(),
    popupMore: await observer.locator("#next").isVisible(),
    hintMore: await hint.getByRole("button", {name:"Check more posts"}).isVisible(),
    popupNoMatches: popup.includes("No matches"),
    hintNoMatches: header.includes("No matches")
  };
  console.log(gate, JSON.stringify(evidence));
  assert.deepEqual(evidence, {scrolls:0,popupMore:false,hintMore:false,popupNoMatches:false,hintNoMatches:false});
  const advanced = await observer.evaluate(id => chrome.tabs.sendMessage(id,{type:"feed-next"}),sourceId);
  assert.equal(advanced,false,"a stale Check more button cannot advance a paused feed");
  for (const message of [popup, header]) {
    assert.ok(message.includes(explanation));
    assert.match(message, /next check at/i);
  }
  await fill([]);
  await until(async () => (await text()).includes("No loaded posts") && (await text()).includes(explanation),
    "empty virtual list keeps gate and next check in popup");
  assert.match(await hint.locator("[role=status]").textContent(), /next check at/i);
  await fill(authors);
  await hint.getByRole("button", {name:"Show all locations"}).click();
  await until(() => source.locator("article:visible").count().then(n => n === authors.length), "escape restores rows");
  assert.equal(await scrolls(),0);
};

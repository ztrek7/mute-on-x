const assert = require("node:assert/strict");

// A confirmed US bookend keeps X's end marker visible. New, mostly Canadian
// fixture authors continually arrive without any reading input.
exports.run = async ({source, observer, until, visits, feed, enabled, state, sourceId, post}, scenario) => {
  await observer.evaluate(() => {
    window.opened = [];
    window.closedHelpers = [];
    window.activations = [];
    chrome.tabs.onCreated.addListener(tab => opened.push(tab.id));
    chrome.tabs.onRemoved.addListener(id => closedHelpers.push(id));
    chrome.tabs.onActivated.addListener(info => activations.push(info.tabId));
  });
  const counts = () => observer.evaluate(() => [opened.length, closedHelpers.length, activations.length]);
  const status = () => observer.evaluate(id => chrome.tabs.sendMessage(id, {type: "feed-status"}), sourceId);
  if (scenario === "data-limit" || scenario === "pending-limit") {
    const author = scenario === "data-limit" ? "quota" : "appwaiting";
    await feed([author, "queue1"]);
    await enabled(true);
    await until(async () => (await state())?.reason === "limited", "server deadline recorded");
    const wait = (await state()).pause - Date.now();
    assert.ok(wait > 895_000 && wait <= 900_000);
    await until(async () => (await status()).includes("X limited lookups"), "show actual server cooldown");
    if (author === "quota") assert.ok(await source.locator("#quota").isVisible());
    await source.keyboard.press("PageDown");
    await source.waitForTimeout(1700);
    assert.equal((await state()).strikes, 1);
    assert.deepEqual(visits.map(v => v.name), [author]);
    assert.deepEqual(await counts(), [0, 0, 0]);
    return;
  }
  if (scenario === "late-append") {
    await feed(["queue1", "queue2"]);
    await enabled(true);
    await until(async () => (await state())?.entries.queue2?.result === "us", "two cold authors confirmed");
    await source.waitForTimeout(20_000);
    await source.evaluate(html => document.querySelector("section").insertAdjacentHTML("beforeend", html),
      post("queue3") + post("queue1", "cached"));
    await until(async () => (await status()).includes("another batch"), "spare credits retire during idle");
    assert.ok(await source.locator("#cached").isVisible());
    assert.ok(await source.locator("#queue3").isHidden());
    await source.waitForTimeout(2000);
    assert.deepEqual(await counts(), [0, 0, 0]);
    await source.keyboard.press("ArrowDown");
    await until(() => source.locator("#queue3").isVisible(), "real reading gesture resumes after late append");
    await enabled(false);
    assert.deepEqual(visits.map(v => v.name), ["queue1", "queue2", "queue3"]);
    assert.deepEqual(await counts(), [0, 0, 0]);
    console.log("late append reused cached row; one new lookup after input; cumulative tabs", await counts());
    return;
  }

  await feed(["queue1"]);
  await source.evaluate(template => {
    const section = document.querySelector("section");
    document.querySelector("main").style.minHeight = "160vh";
    let index = 0;
    window.appendTimer = setInterval(() => {
      if (index < 500) section.insertAdjacentHTML("beforeend", template.replaceAll("AUTHOR", "idle" + ++index));
    }, 350);
    // Brave's resulting scroll events are trusted, even for script/anchoring.
    let down = false;
    window.scrollTimer = setInterval(() => {
      scrollTo(0, down ? 0 : 120);
      down = !down;
      section.dispatchEvent(new WheelEvent("wheel", {deltaY: 100, bubbles: true}));
    }, 750);
  }, post("AUTHOR"));
  const start = Date.now();
  await enabled(true);
  await until(() => visits.length >= 16, "initial bank used", 38_000);
  await source.waitForTimeout(2300);
  assert.equal(visits.length, 16, "a visible US post or programmatic scroll cannot renew demand");
  await source.waitForTimeout(20_000);
  assert.equal(visits.length, 16);
  assert.match(await status(), /another batch/);
  assert.doesNotMatch(await status(), /checking location/);
  await source.evaluate(html => {
    clearInterval(window.scrollTimer);
    scrollTo(0, 0);
    document.querySelector("section").insertAdjacentHTML("beforeend", html);
  }, post("queue1", "repeat"));
  await until(() => source.locator("#repeat").isVisible(), "cached duplicate appears with exhausted budget");
  assert.deepEqual(await counts(), [0, 0, 0]);
  console.log("idle plateau", visits.length, "About loads at", Date.now() - start, "ms; tabs", await counts());

  await source.mouse.move(80, 40);
  // A continuous wheel stream spans longer than the time to spend 16 checks.
  for (let i = 0; i < 140; i++) {
    await source.mouse.wheel(0, 2);
    await source.waitForTimeout(180);
  }
  await until(() => source.locator("#idle16").isVisible(), "genuine input reaches next eligible post");
  assert.equal(visits.length, 32, "one wheel gesture admits one batch");
  assert.deepEqual(await counts(), [0, 0, 0]);
  await source.keyboard.press("ArrowUp");
  await until(() => visits.length > 32, "keyboard reading resumes");
  await enabled(false);
  assert.deepEqual(await counts(), [0, 0, 0]);
  console.log("wheel plateau 32; keyboard resumed; cumulative tabs", await counts());
};

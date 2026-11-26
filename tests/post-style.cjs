const assert = require("node:assert/strict");

module.exports = async function ({source, observer, until, restart, visits}) {
  const repeat = "Check the spare cable";
  const repeated = Array(3).fill(repeat).join("<br>");
  const bullets = ["1. Pack the cable.", "2. Check the plug.", "3. Label the box."].join("\n");
  const cases = [
    ["before", "", "A calm introduction."],
    ["both", "ra", "🚨 An update.<br>" + repeated],
    ["explicit-lines", "r", "A note for the workshop.<br>" + Array(8).fill("Do NOT use the <span>USB 3.0</span> port.").join("<br>")],
    ["normalized", "r", "Check the spare cable!\nCHECK  THE SPARE CABLE…\ncheck the spare cable."],
    ["blocks", "r", "<div>Check the spare cable</div><p>Check the <b>spare</b> cable!</p><div>Check the spare cable</div>"],
    ["sentences", "r", "A short note. Check the spare cable. Check the spare cable! Check the spare cable."],
    ["siren", "a", "  🚨️ A neighborhood update"],
    ["native-img", "a", '<img alt="🚨" aria-hidden="true">A neighborhood update'],
    ["tag", "a", '🚨 <a href="/hashtag/BREAKING">#BREAKING</a>: An update'],
    ["adjacent", "a", "🚨BREAKING: An update"],
    ["breaking", "a", "<b>BREAK</b><span>ING:</span> An update"],
    ["just-in", "a", " JUST&nbsp; IN: The road reopened"],
    ["news", "a", "⚠️ Breaking news — The road reopened"],
    ["news-alert", "a", "🔴 NEWS ALERT<br>The bridge is open"],
    ["hashtag-only", "a", '<a href="/hashtag/JustIn">#JustIn</a> - The bridge is open'],
    ["after", "", "Another calm post."],
    ["ordinary", "", "We mentioned BREAKING: and 🚨 near the end."],
    ["red", "", "🔴 The signal turned red."],
    ["triangle", "", "⚠️ Uneven paving."],
    ["bad", "", "Breaking Bad reviews are out."],
    ["habit", "", "Breaking a habit takes practice."],
    ["in-time", "", "Just in time for the meeting."],
    ["in-case", "", "Just in case you missed it."],
    ["mention", "", '<a href="/example">@example</a> BREAKING: More soon.'],
    ["byline", "", "A calm post."],
    ["quoted", "", "A comment on the original."],
    ["hidden", "", '<span hidden>🚨</span>A plain note. <button>🚨</button>'],
    ["preview", "", '<span>Read this.</span><div data-testid="card.wrapper">🚨<br>' + repeated + "</div>"],
    ["twice", "", repeat + "<br>" + repeat],
    ["ordinary-list", "", bullets],
    ["short", "", "Go now! Go now! Go now!"],
    ["same-word", "", Array(3).fill("again again again").join("\n")],
    ["only-handles", "", Array(3).fill("@sample_a @sample_b @sample_c").join("\n")],
    ["only-urls", "", Array(3).fill('Visit <a href="https://example.invalid/stories">example.invalid/stories</a>').join("\n")],
    ["different-decimals", "", "Use the spare USB 3.0\nUse the spare USB 3.1\nUse the spare USB 3.2"],
    ["wrapping", "", Array(3).fill(repeat).join(" ")],
    ["cross-post1", "", repeat], ["cross-post2", "", repeat], ["cross-post3", "", repeat]
  ];
  // Old installations have preferences and statistics but neither new key.
  await observer.evaluate(() => chrome.storage.local.set({hideAllCaps:true, hideUnverified:true}));
  await observer.reload();
  const stored = () => observer.evaluate(() => chrome.storage.local.get(null));
  assert.equal(await observer.locator("#hideAllCaps").isChecked(), true);
  const repeatBox = observer.locator("#hideRepeatedText"), alertBox = observer.locator("#hideAlertHeadlines");
  assert.equal(await repeatBox.isChecked(), false);
  assert.equal(await alertBox.isChecked(), false);
  assert.ok(!Object.hasOwn(await stored(), "hideAlertHeadlines") && !Object.hasOwn(await stored(), "hideRepeatedText"));
  await observer.locator("#hideAllCaps").uncheck();
  await source.evaluate(({cases, repeated}) => {
    document.querySelector("main").innerHTML = '<section id="rows"></section>';
    for (const [index, [name, , html]] of cases.entries()) {
      const cell = document.createElement("div");
      cell.dataset.testid = "cellInnerDiv";
      const body = index % 2 ? 'data-testid="tweetText"' : 'dir="auto" class="whitespace-pre-wrap"';
      cell.innerHTML = '<article data-testid="tweet" id="' + name + '"><div data-testid="User-Name">' +
        (name === "byline" ? "🚨 BREAKING:" : "Example") + '</div><a href="/example/status/' + (100 + index) +
        '"><time>Today</time></a><div ' + body + '>' + html + '</div></article>';
      if (name === "quoted") cell.querySelector("article").insertAdjacentHTML("beforeend",
        '<div data-slot="embedded-tweet-frame"><div data-testid="tweetText">🚨<br>' + repeated + '</div></div>');
      document.querySelector("#rows").append(cell);
    }
    document.querySelector("#wrapping").style.width = "52px";
  }, {cases, repeated});
  const hidden = () => source.locator("#rows article").evaluateAll(els =>
    els.filter(el => !el.getClientRects().length).map(el => el.id));
  const expected = flag => cases.filter(([, flags]) => [...flags].some(c => flag.includes(c))).map(([name]) => name);
  async function expectFlags(flags) {
    const want = expected(flags);
    await until(async () => JSON.stringify(await hidden()) === JSON.stringify(want), "expected matches for " + flags);
  }
  const count = () => observer.locator("#blockedNow").textContent();
  await expectFlags("");
  await repeatBox.check();
  await expectFlags("r");
  assert.equal(await alertBox.isChecked(), false);
  await alertBox.check();
  await expectFlags("ra");
  const total = expected("ra").length;
  await until(async () => await count() === String(total), "overlapping filters count a status once");
  const gap = await source.evaluate(() => document.querySelector("#after").getBoundingClientRect().top -
    document.querySelector("#before").getBoundingClientRect().bottom);
  assert.ok(Math.abs(gap) <= 1, "no gap between retained bookends");
  await repeatBox.uncheck();
  await expectFlags("a");
  assert.equal(await alertBox.isChecked(), true);
  await alertBox.uncheck();
  await expectFlags("");
  await repeatBox.check();
  await alertBox.check();
  await expectFlags("ra");
  assert.equal(await count(), String(total));
  await source.locator("#native-img img").evaluate(img => { img.alt = "🔴"; });
  await until(() => source.locator("#native-img").isVisible(), "recycled emoji alt restored");
  await source.locator("#native-img img").evaluate(img => { img.alt = "🚨"; });
  await until(() => source.locator("#native-img").isHidden(), "alt-only mutation rechecked");
  await source.locator("#rows").evaluate((rows, repeated) => {
    const cell = rows.lastElementChild.cloneNode(true);
    const row = cell.querySelector("article");
    row.id = "later";
    row.querySelector("a").href = "/example/status/900";
    row.querySelector('[data-testid="tweetText"],[dir="auto"]').innerHTML = repeated;
    rows.append(cell);
  }, repeated);
  await until(async () => await source.locator("#later").isHidden() && await count() === String(total+1), "appended match counted");
  await source.locator("#later").evaluate(row => {
    row.querySelector("a").href = "/example/status/901";
    row.querySelector('[data-testid="tweetText"],[dir="auto"]').textContent = "An ordinary replacement.";
  });
  await until(() => source.locator("#later").isVisible(), "recycled post restored");
  await source.locator("#later").evaluate(row => {
    row.querySelector('[data-testid="tweetText"],[dir="auto"]').firstChild.data = "News alert: New route.";
  });
  await until(async () => await source.locator("#later").isHidden() && await count() === String(total+2), "recycled status counted once");
  assert.equal(visits.length, 0);
  assert.equal((await stored()).hideUnverified, true);
  const warm = await restart();
  await Promise.all(["hideAlertHeadlines","hideRepeatedText"].map(async key => {
    assert.equal(await warm.observer.locator("#"+key).isChecked(), true);
  }));
  await until(async () => await warm.observer.locator("#blockedTotal").textContent() === String(total+2), "all-time total survives restart");
  console.log("PASS independent post-style filters, old preferences, DOM examples, counters, zero gap, recycling and persistence");
};

const assert = require("node:assert/strict");

module.exports = async function ({source, observer, until, restart, visits}) {
  const rows = [
    ["BREAKING NEWS! Here are the details.", true],
    ["NASA launched today. BIG NEWS!", false],
    ["123! THIS IS LATER.", false],
    ["🚨 123 !!!", false],
    ["WHAT A DAY", true],
    ["ÉTÉ À PARIS. more below.", true],
    ["U.S. Army releases a report.", false],
    ["“BIG NEWS!” Here is why.", true],
    ["WATCH NOW<br>Read the details.", true],
    ["Mixed case opener.", false],
    ["Mixed case opener.", false],
    ["", false],
    ["THE U.S. government confirmed it.", false],
    ["🚨 24/7 UPDATE: ALL CLEAR.", true],
    ["See here. <b>BIG UPDATE!</b>", false],
    ["A. Lincoln said it best.", false],
    ["J. K. Rowling announced a new book.", false],
    ["A. B. Smith wrote this today.", false],
    ["J. K. ROWLING ANNOUNCED A NEW BOOK! Details below.", true],
    ["ST. Louis won.", false],
    ["MT. Everest is tall.", false],
    ["FT. Worth played today.", false],
    ["JR. Smith scored.", false],
    ["FT. WORTH WON! Details below.", true],
    ["NO. Details below.", true],
    ["U.S. &amp; Canada reach a deal.", false],
    ["U.S. / U.K. summit begins.", false],
    ["OK! Later details.", true],
    ["🚨🚨<br>BREAKING NEWS!", true],
    ["...THIS IS THE POST", true],
    ["WAIT... more soon.", false],
    ["WAIT… more soon.", false],
    ["AIが世界を変える", false],
    ["GDP增长5%", false],
    ["CEO의 발표가 있었다", false],
    ["US تفرض رسوما جديدة", false],
    ["ΚΑΛΗΜΕΡΑ ΚΟΣΜΕ!", true],
    ["<div>BREAKING NEWS</div><p>Read more here.</p>", true],
    ['BREAKING NEWS <a href="https://example.org/story">example.org/story</a>', true],
    ['<a href="https://example.org/">Read the report</a> NOW', false]
  ];
  const quote = '<div data-slot="embedded-tweet-frame"><div data-testid="tweetText">QUOTED HEADLINE!</div></div>';
  await source.evaluate(({rows,quote}) => {
    document.body.innerHTML = "<main>" + rows.map(([text], i) =>
      '<article data-testid="tweet" id="r'+i+'"><div data-testid="User-Name">ALL CAPS AUTHOR</div>' +
      '<a href="/tester/status/'+(100+i)+'"><time>Today</time></a><div class="whitespace-pre-wrap" dir="auto">'+text+'</div>' +
      (i === 10 ? quote : "") + '</article>').join("") + "</main>";
  }, {rows,quote});
  await observer.goto(new URL("/filters.html",observer.url()).href);
  const toggle = observer.locator("#hideAllCaps");
  assert.equal(await toggle.isChecked(), false);
  await toggle.check();
  const visible = page => page.locator("main > article").evaluateAll(items => items.map(el => !!el.getClientRects().length));
  const expected = rows.map(([,hidden]) => !hidden);
  await until(async () => JSON.stringify(await visible(source)) === JSON.stringify(expected), "only uppercase opening sentences disappear");
  const initial = rows.filter(row => row[1]).length;
  await until(async () => await observer.locator("#blockedNow").textContent() === String(initial), "caps posts counted");
  await source.locator("#r9 [dir=auto]").evaluate(el => { el.textContent = "ALL NEW! Details here."; });
  await until(() => source.locator("#r9").isHidden(),"recycled body rechecked");
  await toggle.uncheck();
  await until(async () => (await visible(source)).every(Boolean),"rows restored");
  await toggle.check();
  await until(async () => await observer.locator("#blockedNow").textContent() === String(initial+1),"one count per post across toggles");
  // Neither filter may consume an empty placeholder ahead of the actual body.
  await source.evaluate(() => {
    document.querySelector("main").innerHTML = ["panel","plain"].map((kind,i) =>
      '<article id="'+kind+'" data-testid="tweet"><a href="/tester/status/'+(800+i)+'">Today</a>' +
      (kind === "panel" ? '<div data-testid="translation"><div data-testid="tweetText"> </div></div>' :
        '<div class="whitespace-pre-wrap" dir="auto"><span hidden>Loading</span></div>') +
      '<div data-testid="tweetText" lang="es">Buenos días a todos.</div></article>').join("") +
      '<article data-testid="tweet"><div data-testid="tweetText" lang="en">ALL CLEAR!</div></article>';
  });
  const language = observer.locator("#hideNonEnglish");
  await toggle.uncheck();
  await language.check();
  const visibilityIs = async (...expected) => JSON.stringify(await visible(source)) === JSON.stringify(expected);
  await until(() => visibilityIs(false, false, true),"language-only skips empty panels");
  await toggle.check();
  await until(() => visibilityIs(false, false, false),"combined filters keep the Spanish originals hidden");
  await language.uncheck();
  await until(() => visibilityIs(true, true, false),"caps alone permits mixed-case originals");
  await source.locator("#plain [lang]").evaluate(el => { el.textContent = "¡BUENOS DÍAS!"; });
  await until(() => source.locator("#plain").isHidden(),"caps alone skips empty leading bodies");
  assert.equal(visits.length,0,"caps-only filter makes no country lookups");
  const warm = await restart();
  assert.equal(await warm.observer.locator("#hideAllCaps").isChecked(),true);
  console.log("PASS all-caps opening filter, recycling, deduplication, toggle and persistence");
};

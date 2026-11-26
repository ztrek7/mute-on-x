const assert = require("node:assert/strict");

function legacy(id, author, text, lang, extra = "") {
  return '<article data-testid="tweet" id="' + id + '"><div data-testid="socialContext"><a href="/Other">Other reposted</a></div>' +
    '<div data-testid="User-Name"><a href="/' + author + '"><span>@' + author + '</span></a></div>' +
    '<a href="/' + author + '/status/123"><time>Nov 19</time></a>' +
    '<div data-testid="tweetText" dir="auto" lang="' + lang + '">' + text + '</div>' + extra +
    '<button lang="es">Traducir publicación</button></article>';
}
// Modern profile fixture uses the slots and permalink shape observed on x.com/X.
const quote = '<div role="link" data-slot="embedded-tweet-frame" data-href="/Maple/status/456">' +
  '<a href="/Maple/status/456" aria-hidden="true"></a><article><a href="/Maple/status/456">Nov 19</a><div class="whitespace-pre-wrap" dir="auto" lang="fr">Merci de votre visite.</div></article></div>';
const posts = [
  legacy("us", "Local", "A clear afternoon at the park.", "en"),
  legacy("mixed", "Local", "Here is the news. Buenos días a todos.", "en"),
  legacy("script", "Local", "Meet us at the station ありがとう", "en"),
  legacy("name", "Local", "Glad to see 李明 at the launch.", "en"),
  legacy("cyrillicName", "Local", "Thanks to Сергей for the notes.", "en"),
  legacy("ambiguous", "Local", "OK", "fr"),
  legacy("media", "Local", '🎉 123 <a href="https://t.co/abc">example.fr</a> @Bonjour', "fr"),
  legacy("nonus", "Maple", "An update from the station.", "en"),
  legacy("region", "Region", "US 🇺🇸", "en"),
  legacy("unknown", "Missing", "Location United States", "en"),
  '<article id="anonymous"><div class="whitespace-pre-wrap" dir="auto" lang="en">A post with a missing byline.</div></article>',
  legacy("translated", "Local", "Pour tous.", "fr", '<div data-testid="translation"><div data-testid="tweetText" lang="en">A message for everyone.</div></div>'),
  legacy("cld", "Local", "Thank you for reading. Nous avons traversé la montagne pour retrouver les amis qui nous attendaient depuis plusieurs jours dans leur village.", "en"),
  '<article id="quote"><a href="/Local/status/987">Nov 19</a><div class="whitespace-pre-wrap" dir="auto" lang="en">My comment</div>' + quote + '</article>',
  '<article id="missingAuthor" data-testid="tweet"><div data-testid="tweetText" lang="en">Only an unknown byline</div>' + quote + '</article>'
];
exports.serveFilters = (req, res) => {
  if (req.url !== "/fixture/feed") return false;
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.end('<!doctype html><html lang="es"><nav><a data-testid="AppTabBar_Profile_Link" href="/fixtureviewer">Profile</a></nav><main>'+posts.join("")+'</main></html>');
  return true;
};

exports.testFilters = async ({ source, observer, worker, hits, until }) => {
  const popup = observer;
  await popup.goto(new URL("/filters.html", worker.url()).href);
  const us = popup.locator("#usOnly");
  const lang = popup.locator("#hideNonEnglish");
  await source.goto("https://x.com/fixture/feed");
  await source.bringToFront();
  const hidden = id => source.locator("#" + id).isHidden();
  const visible = id => source.locator("#" + id).isVisible();
  const all = async (ids, fn) => (await Promise.all(ids.map(fn))).every(Boolean);
  const filters = async (a, b) => {
    // Click the actual popup controls without activating this observer tab.
    for (const [input, target] of [[us, a], [lang, b]]) {
      if (await input.isChecked() !== target) await input.evaluate(el => el.click());
    }
  };
  assert.equal(await us.isChecked(), false);
  assert.equal(await lang.isChecked(), false);
  assert.deepEqual(hits, []);
  const activations = [];
  await popup.exposeFunction("trackAboutTab", (type, id) => activations.push([type,id]));
  await popup.evaluate(() => {
    chrome.tabs.onCreated.addListener(tab => trackAboutTab(tab.active ? "foreground create" : "create", tab.id));
    chrome.tabs.onActivated.addListener(tab => trackAboutTab("activated", tab.tabId));
    chrome.tabs.onRemoved.addListener(id => trackAboutTab("close", id));
  });
  await filters(false, true);
  await until(() => all(["mixed", "script", "name", "cyrillicName", "cld", "quote", "missingAuthor"], hidden), "mixed post and quoted language hidden");
  assert.ok(await all(["us", "nonus", "region", "media", "ambiguous", "unknown"], visible));
  await source.evaluate(html => document.querySelector("main").insertAdjacentHTML("beforeend", html),
    legacy("named", "Local", "An English post", "en").replace("<span>@Local", "<span>李</span><span>@Local") +
    '<article id="quotedName" data-testid="tweet"><a href="/Local/status/120">Nov 19</a>' +
    '<div data-testid="tweetText" lang="en">Read this.</div><div data-slot="embedded-tweet-frame" data-href="/Maple/status/121">' +
    '<a href="/Maple"><div dir="auto">Сергей</div></a><div class="whitespace-pre-wrap" dir="auto" lang="en">English quote</div></div></article>' +
    legacy("decorated", "Local", "English text", "en").replace("<span>@Local", "<span>Sam ✨</span><span>@Local")
      .replace("Other reposted", "他の人がリポスト").replace("Nov 19", "十一月"));
  await until(() => all(["named", "quotedName"], hidden), "non-Latin original and quoted author names remove the whole post");
  assert.ok(await visible("decorated"), "emoji and localized interface text are ignored");
  await source.locator("#named [data-testid=User-Name] span").first().evaluate(el => {el.textContent = "Lee";});
  await until(() => visible("named"), "a recycled byline restores the row");
  await source.evaluate(() => ["named","quotedName","decorated"].forEach(id => document.getElementById(id).remove()));
  // Deliberately use English-only content. Any removal must be due to X's
  // translation UI, including when X adds it after rendering the timeline.
  await source.evaluate(html => document.querySelector("main").insertAdjacentHTML("beforeend", html),
    legacy("automatic","Local","An English rendering.","en",'<div><span>Translated from </span><span>Japanese</span><span> by Grok</span></div>') +
    legacy("translatedQuote","Local","A comment in English.","en",'<div data-testid="quoteTweet"><div data-testid="tweetText" lang="en">A quoted update.</div><button aria-label="Show original"></button></div>') +
    legacy("panelOnly","Local","An update.","en",'<div data-slot="translated-text">English rendering only.</div>') +
    legacy("offered","Local","An original English post.","en",'<button data-testid="translationButton">Translate post</button>') +
    legacy("mentioned","Local","Translated by Grok","en",'<div data-testid="card.wrapper"><button>Show original</button></div>') +
    legacy("reused","Local","Another update.","en",'<div data-slot="post-translation" hidden><div data-testid="tweetText" lang="en">English rendering.</div></div>'));
  await until(() => all(["translated","automatic","translatedQuote","panelOnly"], hidden), "expanded, automatic and quoted translations removed");
  assert.ok(await all(["offered","mentioned","reused"], visible));
  const marker = source.locator("#offered .attribution");
  await source.locator("#offered").evaluate(row => {
    const label = document.createElement("span");
    label.className = "attribution";
    label.textContent = "Translated from the original by the author";
    row.append(label);
  });
  assert.ok(await visible("offered"));
  await marker.evaluate(el => { el.textContent = "Translated from Japanese · Show original"; });
  await until(() => hidden("offered"), "combined attribution in a single text node");
  await marker.evaluate(el => el.remove());
  await until(() => visible("offered"), "unused offer is visible after attribution removed");
  const quoteControl = source.locator("#translatedQuote [aria-label]");
  await quoteControl.evaluate(el => {
    const wrapper = document.createElement("div");
    el.before(wrapper);
    wrapper.append(el);
    wrapper.setAttribute("aria-hidden", "true");
  });
  await until(() => visible("translatedQuote"), "hidden wrapper suppresses a translated quote control");
  await quoteControl.evaluate(el => el.parentElement.removeAttribute("aria-hidden"));
  await until(() => hidden("translatedQuote"), "revealing the control hides its quote");
  await quoteControl.evaluate(el => el.setAttribute("aria-label", "Translate post"));
  await until(() => visible("translatedQuote"), "quote restored when original is displayed");
  await quoteControl.evaluate(el => el.setAttribute("aria-label", "Translated by Grok – Show original"));
  await until(() => hidden("translatedQuote"), "accessible label alone signals translation");
  await source.locator("#reused [data-slot]").evaluate(el => {el.hidden = false;});
  await until(() => hidden("reused"), "translation inserted into a visible row");
  await source.locator("#reused [data-slot]").evaluate(el => el.remove());
  await until(() => visible("reused"), "recycled original restored");
  await filters(false,false);
  await until(() => all(["automatic","translatedQuote","panelOnly"], visible), "switching off restores translations");
  await source.evaluate(() => ["automatic","translatedQuote","panelOnly","offered","mentioned","reused"].forEach(id => document.getElementById(id).remove()));
  await filters(false,true);
  console.log("PASS native translation indicators, quoted and recycled rows, literal mentions, translation offers and restoration");
  // Ignore hover changes, but recognize modern X promoting an existing div to a post body.
  await source.evaluate(() => {
    const row = document.createElement("article");
    row.id = "promoted"; row.dataset.testid = "tweet";
    row.innerHTML = '<div dir="auto" lang="es">Buenos días a todos.</div>';
    document.querySelector("main").append(row);
  });
  assert.ok(await visible("promoted"));
  await source.locator("#promoted > div").evaluate(el => el.classList.add("whitespace-pre-wrap"));
  await until(() => hidden("promoted"), "new body class triggers language check");
  await source.locator("#promoted > div").evaluate(el => el.classList.remove("whitespace-pre-wrap"));
  await until(() => visible("promoted"), "removed body class restores row");
  await source.locator("#promoted").evaluate(el => el.remove());
  assert.deepEqual(hits, []);
  console.log("PASS language alone, original/quoted bodies, mixed Latin and other script, detector, controls, links, emoji and ambiguity");

  await filters(true, false);
  await until(() => all(["region", "unknown", "nonus", "quote", "missingAuthor", "anonymous"], hidden), "unconfirmed hidden immediately");
  await until(() => all(["us", "mixed", "cld", "ambiguous"], visible), "US About field made posts visible", 24_000);
  await until(async () => hits.includes("missing") && (await popup.getByRole("status").textContent()).includes("4 location unavailable"),
    "missing account field stays unavailable", 35_000);
  assert.deepEqual([...hits].sort(), ["local", "maple", "missing", "region"]);
  assert.deepEqual(activations.filter(([type]) => type === "foreground create" || type === "activated"), []);
  assert.deepEqual(activations, [], "country lookups create no tabs");
  assert.equal(await source.locator("aside").count(), 0);
  assert.ok((await popup.getByRole("status").textContent()).includes("2 other country or region"));
  await filters(true, true);
  await until(() => all(["mixed", "script", "cld", "nonus", "quote", "unknown"], hidden), "both filters compose");
  await source.reload();
  await popup.reload();
  await until(async () => (await us.isChecked()) && (await lang.isChecked()) && (await visible("us")) && (await hidden("mixed")), "preferences survive document reload");
  await source.evaluate(() => {
    const post = document.querySelector("#us");
    const copy = post.cloneNode(true);
    copy.id = "scrolled";
    document.querySelector("main").append(copy);
    post.querySelector('a[href*="/status/"]').href = "/Maple/status/991";
    post.querySelector('[data-testid="User-Name"]').innerHTML = '<span>@Maple</span>';
    document.querySelector("#mixed [data-testid=tweetText]").textContent = "Tomorrow we meet again.";
  });
  await until(async () => await hidden("us") && await visible("mixed") && await visible("scrolled"), "recycled author, edited text, appended post");
  await source.evaluate(() => history.pushState({}, "", "/settings/privacy"));
  await until(() => visible("nonus"), "non-feed route restores posts");
  await source.evaluate(() => history.back());
  await until(() => hidden("nonus"), "SPA return reapplies filters");
  await popup.getByRole("button", { name: "Show all locations" }).evaluate(el => el.click());
  await until(async () => !(await us.isChecked()) && await visible("unknown") && await visible("nonus") && await hidden("script"), "easy off preserves language filter");
  await filters(false, false);
  await until(async () => (await source.locator("article:not(article article):visible").count()) === posts.length + 1, "all nodes restored");
  assert.equal(hits.length, 4);
  console.log("PASS strict US alone and combined, in-tab About response, regions, missing fields, duplicate authors, reposts, quotes, dynamic rows, navigation, reload, independent restore");

  await source.evaluate(() => {
    document.querySelector("main").innerHTML = '<article data-testid="tweet" id="limited"><a href="/Limited/status/123">Nov 19</a></article>' +
      '<article data-testid="tweet" id="after"><a href="/After/status/234">Nov 19</a></article>';
  });
  await filters(true, false);
  await until(async () => hits.includes("limited") && (await popup.getByRole("status").textContent()).includes("X limited lookups"), "429 pauses other uncached lookup", 12_000);
  assert.equal(hits.includes("after"), false);
  assert.match(await popup.getByRole("status").textContent(), /X limited lookups/);
  await filters(false, false);
  await until(() => all(["limited", "after"], visible), "throttled rows restored");
  console.log("PASS 429 pauses lookups globally and the feed can be restored immediately");

  await popup.evaluate(() => Promise.all([chrome.storage.session.remove("feedLocationCache"),chrome.storage.local.remove(["feedRequestCooldown","feedVerifiedLocations"])]));
  await source.reload();
  await source.evaluate(() => {
    document.querySelector("main").innerHTML = '<article id="trip" data-testid="tweet"><a href="/Away/status/10">Nov 19</a></article>';
  });
  await filters(true,false);
  await until(()=>hits.includes("away"),"About GET in flight");
  const win = await popup.evaluate(async()=> (await chrome.windows.create({url:"about:blank",focused:true})).id);
  await until(async()=> (await popup.evaluate(()=>chrome.storage.session.get("feedLocationCache"))).feedLocationCache?.entries.away?.result==="us",
    "About data verified while another window is focused",16_000);
  assert.equal(await popup.evaluate(async()=> (await chrome.windows.getLastFocused()).id),win);
  await popup.evaluate(id=>chrome.windows.remove(id),win);
  await source.bringToFront();
  await filters(false,false);
  console.log("PASS tabless About succeeds while the user keeps another window focused");

  await popup.evaluate(() => Promise.all([chrome.storage.session.remove("feedLocationCache"),chrome.storage.local.remove(["feedRequestCooldown","feedVerifiedLocations"])]));
  await source.reload();
  await source.evaluate(() => {
    document.querySelector("main").innerHTML = [1,2,3,4].map(i=>'<article data-testid="tweet"><a href="/absent'+i+'/status/12">Nov 19</a></article>').join("");
  });
  await filters(true,false);
  await until(async()=> (await popup.getByRole("status").textContent()).includes("4 location unavailable"),"individual missing panels finish",30_000);
  assert.deepEqual(hits.filter(h=>/^absent/.test(h)),["absent1","absent2","absent3","absent4"]);
  assert.equal(await source.locator("article:visible,aside").count(),0);
  const showAll = source.getByRole("button", {name: "Show all locations"});
  await showAll.dispatchEvent("click");
  assert.equal(await popup.evaluate(async () => (await chrome.storage.local.get("usOnly")).usOnly), true);
  await showAll.click();
  await until(async()=> (await source.locator("article:visible").count())===4,"inline recovery restores four unknowns");
  assert.equal(await popup.evaluate(async () => (await chrome.storage.local.get("usOnly")).usOnly), true);
  await until(async () => (await popup.getByRole("status").textContent()).includes("until reload"), "popup explains the temporary override");
  await source.reload();
  await until(async () => await source.locator("#nonus").count() === 1 && await hidden("nonus") &&
    !(await popup.getByRole("status").textContent()).includes("until reload"), "strict setting reapplied after reload");
  console.log("PASS inline recovery restores rows only in this document and preserves the saved preference");
  await filters(false, false);

  // A fresh scenario in the disposable profile, independent of the rate limit.
  await popup.evaluate(() => Promise.all([chrome.storage.session.remove("feedLocationCache"),chrome.storage.local.remove(["feedRequestCooldown","feedVerifiedLocations"])]));
  await source.goto("https://x.com/fixture/feed");
  await source.evaluate(() => {
    document.querySelector("main").innerHTML = '<article data-testid="tweet" id="signedout"><a href="/LoginOnly/status/100">Nov 19</a></article>';
  });
  await filters(true, true);
  await until(async () => await hidden("signedout") && (await popup.getByRole("status").textContent()).includes("sign-in required"), "signed-out location unavailable");
  console.log("PASS sign-in gate hides unconfirmed post and explains missing location");
};

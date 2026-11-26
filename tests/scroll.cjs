const assert = require("node:assert/strict");

exports.run = async ({source, observer, until, visits, state, post}, scenario) => {
  if (scenario === "scroll-reveal") {
    await source.goto("https://x.com/shared-feed");
    await source.addStyleTag({content: "html{overflow-anchor:none} article{height:150px}"});
    await source.locator("main").evaluate((main, html) => { main.innerHTML = html; },
      Array.from({length:30}, (_, i) => post("queue1", "kept"+i)).join(""));
    await observer.evaluate(() => chrome.storage.local.set({usOnly:true, hideUnverified:true}));
    await until(async () => (await state())?.entries.queue1?.result === "us" && await source.locator("#kept15").isVisible(),
      "retained author confirmed");
    await source.locator("#kept14").evaluate(el => el.scrollIntoView());
    await source.locator("#kept14").evaluate((el, html) => el.insertAdjacentHTML("beforebegin",html), post("slowpanel"));
    await until(() => visits.some(v => v.name === "slowpanel") && source.locator("#slowpanel").isHidden(), "nearby author check pending");
    await source.mouse.wheel(0, 60);
    await until(() => source.locator("#kept14").evaluate(el => el.getBoundingClientRect().top < -40), "downward wheel moved the reader");
    const top = () => source.locator("#kept16").evaluate(el => el.getBoundingClientRect().top);
    const before = await top();
    await until(() => source.locator("#slowpanel").isVisible(), "newly confirmed post restored");
    const movement = (await top()) - before;
    assert.ok(Math.abs(movement) <= 1, "strict country result displaced the retained post by " + movement + "px");
    console.log("PASS", scenario);
    return;
  }

  if (scenario === "scroll-spacers") {
    await source.goto("https://x.com/shared-feed");
    await source.addStyleTag({content:"article{height:200px} #timeline{height:600px;overflow:auto;overflow-anchor:none}"});
    await source.locator("main").evaluate((main, posts) => {
      main.innerHTML = '<div id="timeline"><section><div aria-hidden="true" style="height:9000px"></div>' +
        posts + '<div aria-hidden="true" style="height:7000px"></div></section></div>';
      document.querySelector("#timeline").scrollTop = 9400;
    }, Array.from({length:10}, (_, i) => '<div data-testid="cellInnerDiv">' + post("local","r"+i) + '</div>').join(""));
    await observer.evaluate(() => chrome.storage.local.set({hideNonEnglish:true}));
    await source.locator("#timeline").hover();
    await source.mouse.wheel(0, 200);
    const scroll = () => source.locator("#timeline").evaluate(el => ({top:el.scrollTop, height:el.scrollHeight}));
    await until(async () => (await scroll()).top === 9600, "nested timeline scrolled down");
    await source.locator("#r8 [data-testid=tweetText]").evaluate(el => { el.textContent = "Buenos días a todos."; });
    await until(() => source.locator("#r8").isHidden(), "below-screen row removed");
    assert.deepEqual(await scroll(), {top:9600,height:17800}, "native virtual spacers keep the scrollable range");
    console.log("PASS", scenario);
    return;
  }

  for (const anchoring of ["none", "auto"]) {
    await observer.evaluate(() => chrome.storage.local.set({hideNonEnglish:false}));
    await source.goto("https://x.com/shared-feed");
    const slot = i => '<div data-testid="cellInnerDiv" style="position:absolute;top:0;width:100%;height:150px;transform:translateY(' +
      i*150 + 'px)">' + post("local", "r"+i) + '</div>';
    await source.evaluate(({html, anchoring}) => {
      document.documentElement.style.overflowAnchor = anchoring;
      document.querySelector("main").innerHTML = '<section id="window" style="position:relative;min-height:6000px">' + html + '</section>';
      const body = document.querySelector("#r14 [data-testid=tweetText]");
      body.lang = "es";
      body.textContent = "Buenos días a todos.";
      scrollTo(0, 2400);
    }, {html:Array.from({length:12}, (_, i) => slot(i+14)).join(""), anchoring});
    await observer.evaluate(() => chrome.storage.local.set({hideNonEnglish:true}));
    await until(() => source.locator("#r14").isHidden(), "offscreen row filtered");
    const measure = () => source.locator("#r18").evaluate(el => ({top:el.getBoundingClientRect().top, y:scrollY, height:document.scrollingElement.scrollHeight}));
    const before = await measure();
    await source.mouse.wheel(0, 70);
    await until(async () => (await measure()).y > before.y, "trusted downward wheel moved the timeline");
    const afterWheel = await measure();
    if (scenario === "scroll-sentinel") {
      await source.locator("#window").evaluate(el => {
        const loader = document.createElement("div");
        loader.dataset.testid = "cellInnerDiv";
        loader.setAttribute("role","progressbar");
        el.append(document.createElement("div"), loader);
      });
    } else {
      await source.locator("#window").evaluate((el, html) => {
        el.firstElementChild.remove();
        el.insertAdjacentHTML("beforeend", html);
      }, slot(26));
    }
    await source.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await measure();
    assert.ok(Math.abs(after.top - afterWheel.top) <= 1 && after.top < before.top,
      JSON.stringify({scenario,anchoring,before,afterWheel,after}));
    assert.equal(after.height,afterWheel.height,"recycling or a loader preserves the timeline scroll range");
    if (scenario === "scroll-recycle") {
      await source.mouse.wheel(0, -60);
      await until(async () => (await measure()).y < after.y, "upward wheel moved the timeline");
      const beforeReturn = await measure();
      await source.locator("#window").evaluate((el, html) => {
        el.lastElementChild.remove();
        el.insertAdjacentHTML("afterbegin", html);
      }, slot(14).replace('lang="en">A report from the park.', 'lang="es">Buenos días a todos.'));
      await until(() => source.locator("#r14").isHidden(), "returning row is filtered again");
      const returned = await measure();
      assert.ok(Math.abs(returned.top - beforeReturn.top) <= 1, JSON.stringify({anchoring, beforeReturn, returned}));
      assert.equal(returned.height, beforeReturn.height, "returning to an earlier window restores its compacted offset");
    }
  }
  console.log("PASS",scenario);
};

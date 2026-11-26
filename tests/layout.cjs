const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

function article(id, lang = "en", author = "Local") {
  return '<article data-testid="tweet" id="' + id + '"><a href="/' + author + '/status/12">@' + author + '</a><div data-testid="tweetText" lang="' + lang + '">' +
    (lang === "en" ? "An English news report." : "Gracias por las noticias.") + '</div></article>';
}
const cell = (post, i) => '<div data-testid="cellInnerDiv" class="cell" style="transform:translateY(' + i*96 + 'px)">' + post + '</div>';
const markup = posts => '<nav><a data-testid="AppTabBar_Profile_Link" href="/fixtureviewer">Profile</a></nav><main><section aria-label="Timeline"><div id="scroller"><div id="list">' +
  '<div aria-hidden="true" style="height:48px"></div>' + posts.map(cell).join("") +
  '<div aria-hidden="true" style="height:96px"></div></div><div id="sentinel">End of loaded posts</div></div></section></main>';
exports.testLayout = async ({ source, observer, until }) => {
  const settings = (usOnly, hideNonEnglish) => observer.evaluate(values => chrome.storage.local.set(values), { usOnly, hideNonEnglish });
  const reset = async posts => {
    await settings(false,false);
    await source.goto("https://x.com/fixture/feed");
    await source.evaluate(html => {
      document.body.innerHTML = '<style>:root{color-scheme:light dark}body{margin:0;font:16px system-ui;background:Canvas;color:CanvasText}.cell{position:absolute;top:0;width:100%;box-sizing:border-box;border-bottom:1px solid gray;height:96px;padding:12px} #list{position:relative;min-height:580px} #scroller{height:260px;overflow-y:auto;width:520px}article a{color:LinkText}</style>' + html;
    }, markup(posts));
  };
  async function geometry() {
    return source.evaluate(() => {
      const rect = id => document.getElementById(id).parentElement.getBoundingClientRect();
      return { gap: rect("after").top - rect("before").bottom, rejected: rect("reject").height, height: document.querySelector("#list").getBoundingClientRect().height };
    });
  }
  async function compact() {
    await until(async () => (await geometry()).height === 192, "compact two 96px cells");
    assert.deepEqual(await geometry(), { gap: 0, rejected: 0, height: 192 });
  }
  await reset([article("before"), article("reject", "es", "Maple"), article("after")]);
  assert.deepEqual(await geometry(), {gap:96,rejected:96,height:580});
  await settings(false,true);
  await until(() => source.locator("#reject").isHidden(), "language exclusion active");
  assert.equal((await geometry()).gap, 0, "CSS pixel gap between accepted row boundaries");
  await compact();
  for (const colorScheme of ["light","dark"]) {
    await source.emulateMedia({ colorScheme });
    await compact();
    if (process.env.FILTER_SCREENSHOTS) {
      await fs.mkdir(process.env.FILTER_SCREENSHOTS,{recursive:true});
      await source.locator("#scroller").screenshot({path:path.join(process.env.FILTER_SCREENSHOTS,colorScheme+".png")});
    }
  }
  await settings(true,false);
  await compact();
  await until(async () => {
    const cache = await observer.evaluate(() => chrome.storage.session.get("feedLocationCache"));
    return cache.feedLocationCache?.entries.maple?.result === "other";
  }, "in-tab About lookup resolved Canada", 25_000);
  await compact();
  await settings(true,true);
  await compact();
  assert.equal(await source.locator("aside").count(),0);
  // Insert a new translated cell between approved rows. Inspect actual paint
  // opportunities, including the first frame after X recycles the DOM.
  const frames = await source.evaluate(async html => {
    const row=document.querySelector("#reject").parentElement;
    row.innerHTML=html;
    const results=[];
    for(let i=0;i<5;i++){
      await new Promise(requestAnimationFrame);
      const r=id=>document.getElementById(id).parentElement.getBoundingClientRect();
      results.push([r("reject").height,r("after").top-r("before").bottom]);
    }
    return results;
  },article("reject","es","Local"));
  assert.ok(frames.every(([height,gap])=>height===0 && gap===0),JSON.stringify(frames));
  await source.evaluate(() => {
    const before=document.querySelector("#before").parentElement, after=document.querySelector("#after").parentElement;
    before.style.transform="translateY(192px)"; after.style.transform="translateY(0px)";
  });
  await until(()=>source.evaluate(()=>document.querySelector("#before").parentElement.getBoundingClientRect().top ===
    document.querySelector("#after").parentElement.getBoundingClientRect().bottom),"recycled visual order");
  await settings(false,false);
  await until(async ()=>(await geometry()).height===580 && (await geometry()).rejected===96,"native spacers and rows restored");
  assert.equal(await source.locator("[data-mox-hide],[data-mox-compact],[data-mox-spacer]").count(),0);
  console.log("PASS absolute virtual cells, spacers and transforms: 96px gap → 0px, 580px → 192px, both themes, independent/combined filters, five paint frames and restoration");

  // Owner screenshot: thirteen pending posts in dark mode, with visible
  // dividers surrounding a half-screen empty media cell.
  await reset(Array.from({length:13},(_,i)=>article("checking"+i,"en","Pending"+i)));
  await source.evaluate(() => {
    let y = 0;
    for (const [i,row] of [...document.querySelectorAll(".cell")].entries()) {
      const h = i === 1 ? 500 : 96;
      row.style.height = h + "px";
      row.style.transform = "translateY(" + y + "px)";
      y += h;
    }
    document.querySelector("#list").style.minHeight = y + "px";
  });
  await settings(true,true);
  const sourceId = await observer.evaluate(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0].id);
  await until(async () => (await observer.evaluate(id=>chrome.tabs.sendMessage(id,{type:"feed-status"}),sourceId)).includes("13 checking location"),
    "owner's thirteen pending rows");
  assert.equal(await source.evaluate(()=>document.querySelector("#list").getBoundingClientRect().height),0);
  assert.ok(await source.locator(".cell").evaluateAll(rows=>rows.every(el=>el.getClientRects().length===0)));
  assert.equal(await source.locator("aside").count(),0);
  await source.evaluate(([first,last])=>{
    const list=document.querySelector("#list");
    list.insertAdjacentHTML("afterbegin",first);
    list.insertAdjacentHTML("beforeend",last);
  },[cell(article("above"),-1),cell(article("below"),20)]);
  await until(()=>source.locator("#below").isVisible(),"cached US bookend bypasses thirteen new checks",2000);
  assert.equal(await source.evaluate(()=>document.querySelector("#below").parentElement.getBoundingClientRect().top -
    document.querySelector("#above").parentElement.getBoundingClientRect().bottom),0);
  if (process.env.FILTER_SCREENSHOTS) {
    await source.locator("#scroller").screenshot({path:path.join(process.env.FILTER_SCREENSHOTS,"pending-dark.png")});
  }
  await settings(false,false);
  await until(async()=>!(await observer.evaluate(()=>chrome.storage.session.get("feedLocationCache"))).feedLocationCache?.lease,
    "cancel outstanding About check after turning US-only off");
  console.log("PASS screenshot reproduction: 13 pending rows including a 500px media cell, zero occupied pixels or dividers, cached US bookends join while lookup is pending");

  // A second geometry seen in virtual lists uses an outer positioned slot
  // and an inner semantic cell. Exercise both scroll-only and IO pagination.
  await reset([article("before"), article("reject","es"), article("after")]);
  await source.evaluate(() => {
    for (const slot of document.querySelectorAll(".cell")) {
      const cell = document.createElement("div");
      cell.dataset.testid = "cellInnerDiv";
      cell.append(slot.firstElementChild);
      slot.removeAttribute("data-testid");
      slot.append(cell);
    }
  });
  await settings(false,true);
  await until(()=>source.evaluate(()=>document.querySelector("#reject").closest(".cell").getBoundingClientRect().height===0 &&
    document.querySelector("#after").closest(".cell").getBoundingClientRect().top===document.querySelector("#before").closest(".cell").getBoundingClientRect().bottom),
    "nested semantic cell collapses its positioned slot");
  await settings(false,false);

  await reset(Array.from({length:6},(_,i)=>article("first"+i,"es","Skipped"+i)));
  await source.evaluate(html => {
    const root=document.querySelector("#scroller"), list=document.querySelector("#list");
    window.appended=0;
    const io=new IntersectionObserver(entries=>{
      if(!entries.at(-1).isIntersecting || window.appended) return;
      io.disconnect(); window.appended++;
      list.insertAdjacentHTML("beforeend",html);
    },{root});
    io.observe(document.querySelector("#sentinel"));
  },Array.from({length:5},(_,i)=>cell(article("next"+i),i+6)).join(""));
  await source.waitForTimeout(100);
  assert.equal(await source.evaluate(()=>window.appended),0);
  await settings(true,true);
  await until(()=>source.locator("#next0").isVisible(),"native IntersectionObserver loads eligible second page after six exclusions");
  const cache = await observer.evaluate(() => chrome.storage.session.get("feedLocationCache"));
  assert.ok(!Object.keys(cache.feedLocationCache.entries).some(handle => handle.startsWith("skipped")));
  assert.equal(await source.evaluate(()=>document.querySelector("#next0").parentElement.getBoundingClientRect().top -
    document.querySelector("#scroller").getBoundingClientRect().top),0);
  await source.evaluate(html=>{
    const scroller=document.querySelector("#scroller");
    scroller.addEventListener("scroll",()=>{
      if(scroller.scrollTop>100) document.querySelector("#next4")?.parentElement.replaceChildren(document.createRange().createContextualFragment(html));
    },{once:true});
    scroller.scrollTop=180;
  },article("recycled","es"));
  await until(async()=>await source.locator("#recycled").count() && await source.locator("#recycled").isHidden(),"real scroll recycles a rejected row");
  assert.equal(await source.locator("#recycled").evaluate(el=>el.parentElement.getBoundingClientRect().height),0);
  await settings(false,false);
  await until(()=>source.locator("#first0").isVisible(),"restore first page");
  await reset([article("skipped1","es"), article("skipped2","es"), article("skipped3","es")]);
  await source.evaluate(html=>{
    const scroll = document.querySelector("#scroller");
    scroll.addEventListener("scroll",()=>{
      if (scroll.scrollHeight - scroll.scrollTop <= scroll.clientHeight + 20 && !document.querySelector("#later")) {
        document.querySelector("#list").insertAdjacentHTML("beforeend",html);
      }
    });
  },cell(article("later"),3));
  await settings(false,true);
  await until(()=>source.locator("#later").isVisible(),"scroll-only end detector appends after first page collapses");
  await settings(false,false);
  console.log("PASS nested slots and scroll-only pagination");
  console.log("PASS empty first virtual viewport loads later matches through a real intersection, scroll recycles a row, no user scroll needed to find first match");
};

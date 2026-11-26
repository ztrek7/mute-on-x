const assert = require("node:assert/strict");

exports.run = async ({source,observer,until,visits,feed,enabled,state,sourceId,post},scenario) => {
  const status = () => observer.evaluate(id => chrome.tabs.sendMessage(id,{type:"feed-status"}),sourceId);
  const text = () => observer.locator("#status").textContent();
  await feed([]);
  await observer.goto(new URL("/filters.html",observer.url()).href);
  await source.bringToFront();
  await source.evaluate(() => {
    document.body.insertAdjacentHTML("afterbegin", '<nav><a aria-label="Profile" href="/fixtureviewer">Profile</a></nav>');
  });
  const fill = async names => source.locator("section").evaluate((el,html) => el.innerHTML=html,names.map(n=>post(n)).join(""));
  const cdp = await source.context().newCDPSession(source);
  const targets = new Set();
  cdp.on("Target.targetCreated", ({targetInfo:t}) => {if(t.type==="page") targets.add(t.targetId);});
  await cdp.send("Target.setDiscoverTargets",{discover:true});
  await cdp.send("Target.getTargets");
  targets.clear();
  await observer.evaluate(() => {
    window.tabEvents = {created:0,activated:0,urls:0};
    window.leaked = false;
    chrome.runtime.onMessage.addListener(msg => {
      if (/fixture-only|Bearer |x-csrf-token|authorization/i.test(JSON.stringify(msg))) window.leaked = true;
    });
    chrome.tabs.onCreated.addListener(()=>tabEvents.created++);
    chrome.tabs.onActivated.addListener(()=>tabEvents.activated++);
    chrome.tabs.onUpdated.addListener((id,change)=>{if(change.url) tabEvents.urls++;});
  });
  // Calibrate both sensors against a short-lived tab in this disposable profile.
  await observer.evaluate(async () => {
    const tab = await chrome.tabs.create({active:false,url:"about:blank"});
    await chrome.tabs.remove(tab.id);
  });
  await until(async () => targets.size >= 1 && (await observer.evaluate(()=>tabEvents.created))===1,"observers calibrated");
  targets.clear();
  await observer.evaluate(() => {tabEvents.created=tabEvents.activated=tabEvents.urls=0;});
  let navigations=0, documentRequests=0;
  source.on("framenavigated",f=>{if(f===source.mainFrame()) navigations++;});
  source.context().on("request",r=>{if(r.resourceType()==="document") documentRequests++;});
  const before=await source.evaluate(()=>({href:location.href,history:history.length}));
  if (scenario.endsWith("-relay") || ["modern","modern-reset","cors"].includes(scenario)) await source.evaluate(()=>{
    document.documentElement.dataset.appVersion="fixture";
    document.head.insertAdjacentHTML("beforeend",'<link rel="alternate" href="https://abs.twimg.com/x-web/x-web/fixture">');
  });
  if (scenario.startsWith("response-")) {
    await require("./responses.cjs").run({source,observer,until,fill,enabled,state,text,visits},scenario.split("-")[1]);
  } else if (scenario.startsWith("pause-")) {
    await require("./pauses.cjs").run({source, observer, sourceId, until, fill, enabled, state, text, visits, post}, scenario.slice(6));
  } else if (scenario === "modern-reset") {
    await fill(["crosslimit","queue1"]); await enabled(true);
    await until(async () => (await text()).includes("X limited lookups"), "cross-origin throttle");
    // The server sends Retry-After of two hours but exposes only reset (45 minutes).
    const untilReset = (await state()).pause;
    assert.equal(untilReset, visits.resetAt);
    assert.deepEqual(visits.map(v=>v.name),["crosslimit"]);
    assert.equal(visits.preflights,1);
  } else if (scenario === "weak-id") {
    await fill(["handleonly"]); await enabled(true);
    await until(() => source.locator("#handleonly").isVisible().then(async yes => yes && (await state())?.entries.handleonly?.result==="us"),"handle-only confirmed");
    await source.locator("section").evaluate((el, html) => el.insertAdjacentHTML("beforeend",html),
      post("handleonly","strong").replace("<a href=", '<div data-testid="User-Name"><a href="/i/user/111">@handleonly</a></div><a href='));
    await until(async () => (await state())?.entries["handleonly@111"]?.result==="unknown", "missing response ID stays unconfirmed");
    assert.ok(await source.locator("#strong").isHidden());
    assert.ok(await source.locator("#handleonly").isVisible());
    assert.equal((await state()).entries.handleonly.result,"us");
    assert.equal(visits.length,2);
    const saved = await observer.evaluate(async () => (await chrome.storage.local.get("feedVerifiedLocations")).feedVerifiedLocations);
    assert.equal(Object.keys(saved.entries).length,1);
    assert.ok(Object.values(saved.entries)[0].until <= Date.now()+30*60_000);
  } else if (scenario === "zero-tabs" || scenario === "modern") {
    await fill(["noidentity","uk","serverfail1"]);
    await source.locator("section").evaluate((s,html)=>s.insertAdjacentHTML("beforeend",html),post("noidentity","repeat"));
    await source.waitForTimeout(250);
    assert.equal(visits.length,0);
    await enabled(true);
    await until(async()=>(await state())?.entries.serverfail1?.reason==="unavailable","transient outcome");
    assert.equal(await source.locator("article:visible").count(),2);
    assert.deepEqual(visits.map(v=>v.name),["noidentity","uk","serverfail1"]);
    const gap=await source.evaluate(()=>document.querySelector("#repeat").getBoundingClientRect().top-
      document.querySelector("#noidentity").getBoundingClientRect().bottom);
    assert.equal(gap,0);
    await source.locator("section").evaluate(el=>el.insertAdjacentHTML("beforeend",
      '<div role="link" style="padding:12px;border-bottom:1px solid" data-href="/noidentity/status/15"><article id="media"><img alt="Photo"></article></div>' +
      '<article data-testid="tweet" id="conflict"><div data-testid="User-Name"><span>@uk</span></div><a href="/noidentity/status/99">Post</a></article>'));
    await until(()=>source.locator("#media").isVisible(),"confirmed outer media permalink");
    await until(()=>source.locator("#conflict").isHidden(),"conflicting byline stays unknown");
    await source.locator("#media").evaluate(el=>el.parentElement.dataset.href="/uk/status/16");
    await until(()=>source.locator("#media").isHidden(),"outer recycled permalink rechecked");
    assert.equal(await source.locator("#media").evaluate(el=>el.parentElement.getBoundingClientRect().height),0);
    await until(async()=>(await text()).includes("2 shown"),"popup reflects recycled media row");
    await until(()=>observer.locator("#metrics").textContent().then(t=>t.includes("3 About requests") && t.includes("first US post")),"local diagnostics");
  } else if (scenario === "cors") {
    await fill(["corsdenied"]); await enabled(true);
    await until(async()=>(await state())?.entries.corsdenied?.reason==="unavailable","CORS rejection");
    assert.ok(await source.locator("#corsdenied").isHidden());
    assert.equal(visits.length,0);
    assert.equal(visits.preflights,1);
  } else if (scenario === "budget") {
    await observer.evaluate(()=>chrome.storage.local.set({feedRequestTimes:Array(96).fill(Date.now())}));
    await fill(["queue1"]); await enabled(true);
    await until(async()=>(await text()).includes("Hourly lookup allowance"),"popup shows budget");
    assert.equal(visits.length,0);
  } else if (scenario === "signed-out") {
    await source.evaluate(()=>cookieStore.delete({name:"ct0",domain:"x.com",path:"/"}));
    await fill(["queue1"]); await enabled(true);
    await until(async()=>(await text()).includes("sign-in required"),"popup reports missing session");
    assert.equal(visits.length,0);
  } else if (scenario === "gates") {
    for (const [name,reason,description] of [["drift","schema","response changed"],["badbox","schema","response changed"],["challenge","access","denied access"],
      ["denied","access","denied access"],["redirect","access","denied access"],["gqlrate","limited","limited lookups"],["gqlauth","login","sign-in required"],
      ["near","limited","limited lookups"]]) {
      await enabled(false);
      // Each gate is an independent artificial response, in the disposable profile only.
      await observer.evaluate(()=>Promise.all([chrome.storage.session.remove("feedLocationCache"),chrome.storage.local.remove("feedRequestCooldown")]));
      await fill([name]); await enabled(true);
      await until(async()=>(await state())?.reason===reason && (await text()).includes(description),"popup gate "+name);
      if(name==="near"){
        assert.ok((await state()).pause-Date.now()>895000);
        assert.ok(await source.locator("#near").isVisible());
      }
    }
  } else if (scenario === "stale") {
    await fill(["slowpanel"]); await enabled(true);
    await until(()=>visits.length===1,"first viewer started");
    await source.locator("nav a").evaluate(a=>a.href="/otherviewer");
    await until(()=>visits.length===2,"new viewer must independently query");
    assert.ok(await source.locator("#slowpanel").isHidden());
    await until(async()=>await source.locator("#slowpanel").isVisible(),"second viewer verified");
  }
  assert.equal(targets.size,0,"new page targets since calibrated baseline");
  assert.deepEqual(await observer.evaluate(()=>tabEvents),{created:0,activated:0,urls:0});
  assert.ok(await observer.evaluate(async () => {
    const values = await Promise.all([chrome.storage.local.get(null),chrome.storage.session.get(null)]);
    return !window.leaked && !/fixture-only|Bearer |x-csrf-token|authorization/i.test(JSON.stringify(values));
  }), "session material stays out of extension storage and messages");
  assert.equal(documentRequests,0); assert.equal(navigations,0);
  assert.deepEqual(await source.evaluate(()=>({href:location.href,history:history.length})),before);
  await cdp.detach();
  console.log("zero targets, created tabs, activations, top-frame commits and document requests;",visits.length,"About GETs;",visits.preflights || 0,"CORS preflights");
};

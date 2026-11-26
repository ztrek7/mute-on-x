const assert = require("node:assert/strict");

exports.run = async ({source,observer,until,fill,enabled,state,text,visits}, kind) => {
  if (kind === "repeat") {
    const names = ["cutjson1","cutjson2","cutjson3","cutjson4","cutjson5","queue1"];
    await fill(names);
    await enabled(true);
    await until(async () => (await state())?.reason === "unavailable", "transient backoff after three bad replies");
    assert.deepEqual(visits.map(v=>v.name), names.slice(0,3));
    const deadline = (await state()).pause;
    assert.ok(deadline-Date.now() > 28000);
    assert.ok(await observer.locator("#next").isHidden());
    await until(() => source.locator("#queue1").isVisible(), "next healthy author reached after cooldown", 45_000);
    assert.ok(visits[3].time >= deadline);
    assert.deepEqual(visits.map(v=>v.name),names);
    assert.equal(await source.locator("article:visible").count(),1);
    console.log("Repeated transient failures paused once and recovered in",visits.at(-1).time-visits[0].time,"ms");
    return;
  }
  if (kind === "controls") {
    for (const [name,reason] of [["drift","schema"],["badbox","schema"],["gonequery","schema"],
      ["partialauth","login"],["partialrate","limited"],["cutjsonquota","limited"],["challenge","access"]]) {
      await enabled(false);
      await observer.evaluate(()=>Promise.all([chrome.storage.session.remove("feedLocationCache"),
        chrome.storage.local.remove("feedRequestCooldown")]));
      const before = visits.length;
      await fill([name,"queue1"]); await enabled(true);
      await until(async () => (await state())?.reason===reason && /Next check at/.test(await text()),name+" gate");
      assert.deepEqual(visits.slice(before).map(v=>v.name),[name]);
      assert.equal(await source.locator("article:visible").count(),0);
      assert.ok(await observer.locator("#next").isHidden());
      assert.doesNotMatch(await text(),/No matches/);
    }
    return;
  }

  const expected = kind === "ambiguous" ? {
    cutjson1:"unavailable", queue1:"us", emptydata:"unknown", queue2:"us",
    emptyuser:"unknown", queue3:"us", emptyresult:"unknown", bare404:"unavailable", queue4:"us"
  } : {
    partialgood:"us", partialcountry:"unavailable", queue1:"us", partialid:"unavailable",
    partialwrong:"unknown", partialmissing:"unknown", partialbroad:"unknown", partialunsure:"unknown", partialflag:"unknown",
    partialboth:"unavailable", queue2:"us", partialroot:"unavailable", queue3:"us"
  };
  const names = Object.keys(expected);
  await fill(names);
  await enabled(true);
  await until(async () => {
    const s = await state();
    if (s?.pause > Date.now()) throw new Error("Unexpected global "+s.reason+" pause after "+visits.map(v=>v.name));
    const last = names.at(-1);
    return s?.entries[last]?.result === "us" && await source.locator("#"+last).isVisible();
  },"all following US authors reached",24_000);
  const entries = (await state()).entries;
  for (const [name,outcome] of Object.entries(expected)) {
    assert.equal(entries[name]?.reason,outcome,name);
    assert.equal(await source.locator("#"+name).isVisible(),outcome === "us",name);
  }
  assert.deepEqual(visits.map(v=>v.name),names);
  const positives = Object.values(expected).filter(outcome=>outcome==="us").length;
  const cached = await observer.evaluate(async ()=>(await chrome.storage.local.get("feedVerifiedLocations")).feedVerifiedLocations);
  assert.equal(Object.keys(cached.entries).length,positives);
  console.log(kind, names.length,"single lookups,",positives,"verified, no global pause");
};

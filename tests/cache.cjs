const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  let now = Date.now(), receive, reads = 0;
  let outcome = "us";
  const data = {local:{usOnly:true},session:{}};
  const storage = Object.fromEntries(Object.entries(data).map(([area,obj])=>[area,{
    get: async key => ({[key]:structuredClone(obj[key])}),
    set: async values => Object.assign(obj, structuredClone(values))
  }]));
  const chrome = {storage,runtime:{onMessage:{addListener:fn=>receive=fn}},tabs:{
    sendMessage:async (_,msg)=>{ reads++; return {outcome,viewer:msg.viewer,id:"111"}; }
  }};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,"../extension/location-cache.js"),"utf8"), {
    chrome, crypto:globalThis.crypto, TextEncoder, console, setTimeout, clearTimeout,
    Date:class extends Date {static now(){return now;}}
  });
  const lookup = (viewer,key,tab=1,incognito=false) => new Promise(resolve=> receive({
    type:"feed-location",handle:key.split("@")[0],key,viewer
  },{tab:{id:tab,incognito},origin:"https://x.com",frameId:0,documentId:"doc"+tab},resolve));
  await Promise.all([lookup("alice","sample"),lookup("alice","sample",2)]);
  assert.equal(reads,1);
  now+=2000; await lookup("bob","sample",2); assert.equal(reads,2);
  now+=2000; await lookup("alice","sample"); assert.equal(reads,2);
  const disk = JSON.stringify(data.local);
  await lookup("alice","sample",3,true);
  assert.equal(reads,3); assert.equal(JSON.stringify(data.local),disk);
  assert.ok(!/alice|bob|sample/.test(disk));
  now+=32*60_000; await lookup("alice","sample"); assert.equal(reads,4);
  now+=2000; const qualified=await lookup("alice","sample@111");
  assert.equal(qualified.until-now,24*3600_000);
  // Inject expired and over-cap synthetic keys; the next verified write must prune both.
  const cache=data.local.feedVerifiedLocations;
  cache.entries.expired={until:now-1,result:"us"};
  for(let i=0;i<405;i++) cache.entries["fake"+i]={until:now+3600_000,result:"other"};
  now+=2000; await lookup("alice","next");
  assert.equal(Object.keys(data.local.feedVerifiedLocations.entries).length,400);
  assert.ok(!data.local.feedVerifiedLocations.entries.expired);
  outcome = "unavailable";
  now += 2000;
  const first = await lookup("alice","temporary");
  assert.equal(first.until-now,120_000);
  outcome = "us";
  const afterFailure = reads;
  now = first.until-1;
  assert.equal((await lookup("alice","temporary")).result,"unknown");
  assert.equal(reads,afterFailure);
  now++;
  assert.equal((await lookup("alice","temporary")).result,"us");
  assert.equal(reads,afterFailure+1);
  console.log("PASS transient author retries once after its two-minute session entry expires");
  console.log("PASS cache isolation, in-flight sharing, private session-only results, expiry and 400-entry bound");
})().catch(error=>{console.error(error);process.exitCode=1;});

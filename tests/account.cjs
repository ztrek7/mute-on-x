const assert = require("node:assert/strict");

// A fixture session exercises the ordinary same-origin GET and cookie/CSRF
// pairing. No credentials or request header values enter test output.
exports.serve = (req, res, visits, hits) => {
  const url = new URL(req.url, "https://x.com");
  const modern = req.headers[":authority"] === "api.x.com";
  if (!url.pathname.startsWith(modern ? "/graphql/" : "/i/api/graphql/")) return false;
  assert.equal(url.pathname, modern ? "/graphql/3M2SBIjPPDiTvMXkIWTx_w/AboutAccountQuery" :
    "/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery");
  if (modern) {
    assert.equal(req.headers.origin, "https://x.com");
    res.setHeader("Access-Control-Allow-Origin", "https://x.com");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Expose-Headers", "X-Rate-Limit-Remaining, X-Rate-Limit-Reset");
    if (req.method === "OPTIONS") {
      visits.preflights = (visits.preflights || 0) + 1;
      if (JSON.parse(url.searchParams.get("variables")).screenName === "corsdenied") {
        res.removeHeader("Access-Control-Allow-Origin"); res.writeHead(403); res.end(); return true;
      }
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.setHeader("Access-Control-Allow-Headers", "authorization, x-csrf-token, x-twitter-active-user, x-twitter-auth-type, x-twitter-client-language");
      res.writeHead(204); res.end(); return true;
    }
  }
  assert.equal(req.method, "GET");
  const vars = JSON.parse(url.searchParams.get("variables"));
  const provider = "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider";
  assert.deepEqual(Object.keys(vars), modern ? ["screenName", provider] : ["screenName"]);
  if (modern) assert.equal(vars[provider], true);
  const name = vars.screenName;
  assert.match(name, /^[a-z0-9_]{1,15}$/);
  assert.equal(req.headers["sec-fetch-dest"], "empty");
  assert.ok(req.headers.authorization?.startsWith("Bearer "));
  assert.ok(req.headers["x-csrf-token"] === "fixture-only");
  assert.ok(req.headers.cookie?.includes("ct0=fixture-only"));
  visits.push({name, time: Date.now()});
  hits.push(name);
  const label = (name === "region") ? "North America" :
    /^(maple|foreign|helpercase|idle(?!16$)\d+|queue(?:2\d|3[0-7]))$/.test(name) ? "Canada" : "United States";
  const result = {__typename: "User", core: {screen_name: name}, rest_id: "111", about_profile: {account_based_in: label}};
  if (/^(missing|absent|noarea|pending)/.test(name)) {
    result.about_profile = {};
    result.legacy = {location: "United States"};
  }
  if (name === "warnings") result.about_profile.location_accurate = false;
  if (name === "uk") result.about_profile.account_based_in = "UK";
  if (name === "westasia") result.about_profile.account_based_in = "West Asia";
  if (name === "tombstone") { result.__typename = "UserUnavailable"; delete result.about_profile; }
  if (name === "wrongname") result.core.screen_name = "someotheruser";
  if (name === "wrongid") result.rest_id = "222";
  if (name === "handleonly") delete result.rest_id;
  if (name === "noidentity") { delete result.core; delete result.rest_id; }
  if (name === "appstore") result.about_profile = {source: "United States App Store"};
  let body = {data: {user_result_by_screen_name: {result}}};
  if (name === "gqlrate") body = {errors: [{code: "88"}], ...body};
  if (name === "gqlauth") body = {errors: [{code: 89}], ...body};
  if (name.startsWith("cutjson")) {
    if (name === "cutjsonquota") res.setHeader("x-rate-limit-remaining","0");
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end('{"data":');
    return true;
  }
  if (name === "emptydata") body = {data:{}};
  if (name === "emptyuser") body = {data:{user_result_by_screen_name:{}}};
  if (name === "emptyresult") body = {data:{user_result_by_screen_name:{result:{}}}};
  if (name === "bare404") { res.statusCode = 404; body = {}; }
  if (name === "gonequery") {
    res.statusCode = 404;
    body = {errors:[{message:"Query not found"}]};
  }
  if (name.startsWith("partial")) {
    const field = {partialcountry:"about_profile", partialid:"core"}[name] || "affiliates_highlighted_label";
    body.errors = [{code:0,path:["user_result_by_screen_name","result",field]}];
    if (name === "partialmissing") { delete result.rest_id; delete result.core; }
    if (name === "partialflag") result.about_profile.location_accurate = "false";
    if (name === "partialunsure") result.about_profile.location_accurate = false;
    if (name === "partialwrong") result.core.screen_name = "anotherauthor";
    if (name === "partialbroad") result.about_profile.account_based_in = "North America";
    if (name === "partialboth") body.errors.push({code:0,path:["user_result_by_screen_name","result","rest_id"]});
    if (name === "partialroot") body.errors = [{message:"Unspecified failure"}];
    if (name === "partialauth") body.errors.push({code:89});
    if (name === "partialrate") body.errors.push({code:88});
  }
  if (name === "drift") body = {data: {new_shape: result}};
  if (name === "badbox") body = {data:{user_result_by_screen_name:{unexpected:result}}};
  if (name === "near") { res.setHeader("x-rate-limit-remaining","2"); res.setHeader("x-rate-limit-reset", String(Date.now()+900_000)); }
  if (name === "quota") { res.setHeader("x-rate-limit-remaining","0"); res.setHeader("x-rate-limit-reset", String(Math.floor(Date.now()/1000)+900)); }
  if (["limited","slow429","appdata","appwaiting"].includes(name)) {
    res.statusCode = 429;
    res.setHeader("Retry-After", name === "slow429" ? "7200" : "900");
  }
  if (name === "crosslimit") {
    visits.resetAt = (Math.floor(Date.now()/1000)+2700)*1000;
    res.statusCode = 429;
    res.setHeader("Retry-After","7200");
    res.setHeader("X-Rate-Limit-Reset",String(visits.resetAt/1000));
  }
  if (name === "redirect") { res.writeHead(307,{Location:"/login"});res.end();return true; }
  if (name === "denied") res.statusCode = 403;
  if (name === "loginonly") res.statusCode = 401;
  if (name === "challenge") { res.setHeader("Content-Type","text/html"); res.end("<main>Verification required</main>"); return true; }
  if (name.startsWith("serverfail") && !visits.recovered) res.statusCode = 503;
  const send = () => {res.setHeader("Content-Type", "application/json");res.end(JSON.stringify(body));};
  if (name === "slowpanel" || name === "away") setTimeout(send, name === "slowpanel" ? 2500 : 900);
  else send();
  return true;
};

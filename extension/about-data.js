// These are public identifiers from X's web client. They identify the client
// and a read-only account operation, never a signed-in person.
const legacyEndpoint = "https://x.com/i/api/graphql/XRqGa7EeokUU5kppkh13EA/AboutAccountQuery";
const relayEndpoint = "https://api.x.com/graphql/3M2SBIjPPDiTvMXkIWTx_w/AboutAccountQuery";
const webClient = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const aboutMetrics = {requests: 0, lastMs: null, last: ""};

let regionNames;
function knownCountry(value) {
  if (!regionNames) {
    const names = new Intl.DisplayNames(["en"], {type: "region", fallback: "none"});
    regionNames = new Set();
    function include(code) {
      if (["EU", "EZ", "UN", "QO", "ZZ"].includes(code)) return;
      const name = names.of(code);
      if (name) regionNames.add(name.toLowerCase());
    }
    for (const first of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      for (const last of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") include(first + last);
    }
  }
  return regionNames.has(value.toLowerCase());
}
function locationValue(text) {
  if (/^(?:United States(?: of America)?|U\.?S\.?(?:A\.?)?)$/i.test(text)) return "us";
  return /^U\.?K\.?$/i.test(text) || knownCountry(text) ? "other" : null;
}

function serverDeadline(headers) {
  const wait = headers.get("retry-after");
  const timestamp = Number(headers.get("x-rate-limit-reset"));
  const reset = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const delay = /^\d+$/.test(wait) ? Date.now() + Number(wait) * 1000 : Date.parse(wait);
  return Math.max(Number.isFinite(delay) ? delay : 0, Number.isFinite(reset) ? reset : 0);
}
function emptyObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}
function errorOutcome(errors) {
  if (errors.some(e => Number(e?.code) === 88)) return "limited";
  if (errors.some(e => [32, 89, 99, 215, 326].includes(Number(e?.code)))) return "login";
  if (errors.some(e => !e?.path?.length && (e?.extensions?.code === "PERSISTED_QUERY_NOT_FOUND" ||
    /^(?:query not found|persistedquerynotfound)$/i.test(e?.message || "")))) return "schema";
  if (errors.some(e => [50, 63].includes(Number(e?.code)))) return "unknown";
  // A dependency error on a known display-only sibling can leave the
  // requested identity and About fields intact. Unscoped errors cannot.
  const displayOnly = errors.every(e => [0, "0"].includes(e?.code) && Array.isArray(e.path) &&
    e.path[0] === "user_result_by_screen_name" && e.path[1] === "result" &&
    e.path[2] === "affiliates_highlighted_label");
  return displayOnly ? null : "unavailable";
}
function readAccount(body, handle, expectedId) {
  if (body?.errors != null && !Array.isArray(body.errors)) return {outcome: "unavailable"};
  const errors = body?.errors || [];
  if (errors.length) {
    const outcome = errorOutcome(errors);
    if (outcome) return {outcome};
  }
  if (emptyObject(body) || body?.data === null) return {outcome: "unavailable"};
  if (emptyObject(body?.data)) return {outcome: "unknown"};
  if (!body?.data || !Object.hasOwn(body.data, "user_result_by_screen_name")) return {outcome: "schema"};
  const box = body.data.user_result_by_screen_name;
  if (box === null || emptyObject(box) || box?.result === null || emptyObject(box?.result)) {
    return {outcome: "unknown"};
  }
  const result = box?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return {outcome: "schema"};
  if (["UserUnavailable", "UserTombstone"].includes(result.__typename)) return {outcome: "unknown"};
  if (result.__typename && result.__typename !== "User") return {outcome: "schema"};
  const names = [result.core?.screen_name, result.legacy?.screen_name].filter(name => name != null);
  const id = typeof result.rest_id === "string" && /^\d{1,20}$/.test(result.rest_id) ? result.rest_id : null;
  if (names.some(name => typeof name !== "string" || name.toLowerCase() !== handle) ||
      (expectedId && expectedId !== id) || (errors.length && !names.length && !expectedId)) return {outcome: "unknown"};
  // The exact GET, document and viewer bind a minimal response to its single
  // requested handle. Only a matching returned ID earns ID-qualified reuse.
  if (!Object.hasOwn(result, "about_profile")) {
    return {outcome: result.__typename === "User" || names.length || id ? "unknown" : "schema"};
  }
  const profile = result.about_profile;
  if (profile && Object.hasOwn(profile, "location_accurate") && profile.location_accurate !== true) {
    return {outcome: "unknown"};
  }
  const value = profile?.account_based_in;
  return {outcome: typeof value === "string" ? locationValue(value.trim()) || "unknown" : "unknown", id};
}

function usesModernXClient() {
  return !!document.documentElement.dataset.appVersion &&
    !!document.querySelector('link[href^="https://abs.twimg.com/x-web/x-web/"]');
}

async function fetchAccount(msg, signal) {
  if (location.origin !== "https://x.com" || window !== window.top || !/^[a-z0-9_]{1,15}$/.test(msg.handle) ||
      feedViewer() !== msg.viewer || signal.aborted) return {outcome: "cancelled"};
  const csrf = await cookieStore.get("ct0");
  if (!csrf?.value) return {outcome: "login"};
  if (signal.aborted || feedViewer() !== msg.viewer) return {outcome: "cancelled"};
  const relay = usesModernXClient();
  const url = new URL(relay ? relayEndpoint : legacyEndpoint);
  const variables = {screenName: msg.handle};
  if (relay) variables.__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider = Boolean(msg.viewer);
  url.searchParams.set("variables", JSON.stringify(variables));
  const start = performance.now();
  let answer;
  try {
    aboutMetrics.requests++;
    const res = await fetch(url, {
      method: "GET", mode: relay ? "cors" : "same-origin", credentials: relay ? "include" : "same-origin", redirect: "manual", cache: "no-store", signal,
      headers: {authorization: "Bearer " + webClient, "x-csrf-token": csrf.value,
        "x-twitter-auth-type": "OAuth2Session", "x-twitter-active-user": "yes", "x-twitter-client-language": "en"}
    });
    const reset = serverDeadline(res.headers);
    if (res.status === 429) answer = {outcome: "limited", retryAt: reset};
    else if (res.status === 401) answer = {outcome: "login"};
    else if (res.status === 403 || res.type === "opaqueredirect") answer = {outcome: "access"};
    else if (res.status === 404) {
      // A bare 404 can concern one author. Only an explicit operation error
      // identifies a removed query; never accept country data on an HTTP error.
      const body = await res.json().catch(() => null);
      const errors = Array.isArray(body?.errors) ? body.errors : [];
      const outcome = errorOutcome(errors) || "unavailable";
      answer = {outcome, retryAt: outcome === "limited" ? reset : 0};
    } else if (res.status === 410) answer = {outcome: "schema"};
    else if (!res.ok) {
      answer = {outcome: "unavailable", retryAt: res.status === 503 ? reset : 0};
    } else if (res.url !== url.href || !res.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      answer = {outcome: "access"};
    } else {
      const body = await res.json().catch(() => undefined);
      answer = body === undefined ? {outcome: "unavailable"} : readAccount(body, msg.handle, msg.key.split("@")[1]);
      const left = res.headers.get("x-rate-limit-remaining");
      if (answer.outcome === "limited" || (left !== null && /^\d+$/.test(left) && Number(left) <= 2)) {
        answer.exhausted = true;
        answer.retryAt = reset;
      }
    }
  } catch {
    answer = {outcome: signal.reason?.name === "AbortError" ? "cancelled" : "unavailable"};
  }
  aboutMetrics.lastMs = Math.round(performance.now() - start);
  aboutMetrics.last = answer.outcome;
  // A real throttle applies even if the viewer changes during the response.
  if (!["limited","login","access"].includes(answer.outcome) && (signal.reason?.name === "AbortError" || msg.viewer !== feedViewer())) {
    return {...answer, outcome: "cancelled", id: null};
  }
  return {...answer, viewer: msg.viewer};
}

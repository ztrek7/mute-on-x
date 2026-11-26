// Only the native context-menu action calls this in the originating X document.
async function saveMutedWord(term, pageUrl) {
  if (term.length > 140) throw new Error("Choose a word or phrase of 140 characters or fewer.");
  const checkSettings = "Check your muted words in X settings before trying again.";
  return navigator.locks.request("mute-on-x:save", {ifAvailable: true}, async lock => {
    if (!lock) throw new Error("Another mute is in progress. Wait for its result.");
    const csrf = (await cookieStore.get("ct0"))?.value;
    if (!csrf) throw new Error("Sign in to X, then choose Mute on X again.");
    const modern = usesModernXClient();
    const base = modern ? "https://api.x.com/1.1/mutes/keywords/" : "https://x.com/i/api/1.1/mutes/keywords/";
    let writeStarted = false;
    async function checkSession() {
      if ((await cookieStore.get("ct0"))?.value !== csrf || location.href !== pageUrl) {
        throw new Error("The X page or session changed. " + checkSettings);
      }
    }
    async function request(action, body) {
      await checkSession();
      if (body) writeStarted = true;
      const uncertain = writeStarted ? "Save unconfirmed. " + checkSettings :
        "Couldn’t read your muted words. Open X settings to check your sign-in.";
      let response, data;
      // A streamed body cannot be replayed if the connection drops after X
      // reads the POST. Chromium requires HTTP/2 or newer for these uploads.
      const headers = {authorization: "Bearer " + webClient, "x-csrf-token": csrf,
        "x-twitter-active-user": "yes", "x-twitter-auth-type": "OAuth2Session"};
      let upload;
      if (body) {
        headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
        upload = new Blob([body.toString()]).stream();
      }
      try {
        response = await fetch(base + action + ".json", {
          method: body ? "POST" : "GET", body: upload, duplex: "half",
          mode: modern ? "cors" : "same-origin", credentials: modern ? "include" : "same-origin",
          redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(8000),
          headers
        });
      } catch {
        throw new Error(uncertain);
      }
      if (response.status === 429) throw new Error("X is rate-limiting requests. Wait before trying again.");
      if (response.status === 401) throw new Error("X requires sign-in. Open X settings to check your session.");
      if (response.status === 403 || response.type === "opaqueredirect")
        throw new Error("X denied access or requires verification. Open X settings to continue.");
      if (!response.ok) throw new Error(`X returned HTTP ${response.status}. ` + uncertain);
      try {
        data = await response.json();
      } catch {
        throw new Error(uncertain);
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(uncertain);
      if (data.error || data.errors?.length) throw new Error("X reported a problem. " + checkSettings);
      await checkSession();
      return data;
    }
    const fold = value => value.trim().normalize("NFC").toLowerCase();
    async function listed() {
      const {muted_keywords: words} = await request("list");
      if (!Array.isArray(words) || !words.every(row => row && (typeof row.id === "string" && row.id.length > 0 || Number.isSafeInteger(row.id)) &&
          typeof row.keyword === "string" && row.keyword.trim()))
        throw new Error("Couldn’t verify X’s muted-word list. " + checkSettings);
      return words.some(row => fold(row.keyword) === fold(term));
    }
    if (await listed()) return `“${term}” is already in your muted words.`;
    await request("create", new URLSearchParams({
      keyword: term, mute_surfaces: "notifications,home_timeline,tweet_replies", mute_options: "", duration: ""
    }));
    if (!(await listed())) throw new Error("Save unconfirmed. " + checkSettings);
    return `Confirmed “${term}” in your muted words.`;
  });
}

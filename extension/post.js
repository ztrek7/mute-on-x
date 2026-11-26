// Read the post body and its byline separately from X's navigation, social
// context ("reposted"), link previews, and quoted posts.
const feedPosts = (() => {
  const bodySelector = '[data-testid="tweetText"], div[dir="auto"].whitespace-pre-wrap';
  const quoteSelector = '[data-slot="embedded-tweet-frame"],[data-testid="quoteTweet"],article,[role="link"]';
  const handlePattern = /^@([a-z0-9_]{1,15})$/i;
  const unknownLang = /^(?:en|und|zxx|mul|art|q[a-t][a-z]|x)(?:-|$)/i;
  const translationPanel = '[data-testid="translation"],[data-testid="tweetTranslation"],[data-testid="translatedTweetText"],[data-slot="post-translation"],[data-slot="translated-text"]';
  const originalControl = /^(?:show|view|see) original(?: (?:post|text|tweet))?$/i;
  const translatedLabel = /^(?:auto[- ]?)?translated (?:from (?!(?:the )?original\b)[\p{L}\p{M} .()’-]{1,50}(?: by [\p{L} ]+)?|by (?:Grok|Google|Microsoft|Bing)(?: Translate| Translator)?)[.]?$/iu;

  function hasAttribution(value) {
    // X can combine its attribution and original-text action into one label.
    const caption = value.replace(/\s*[-–—·•|]\s*(?:show|view|see) original(?: (?:post|text|tweet))?$/i, "");
    return translatedLabel.test(caption);
  }

  const visibilityEvidence = bodySelector + "," + translationPanel +
    ',[data-testid="User-Name"],[aria-label*="translat" i],[aria-label*="original" i]';

  function isTranslationLabel(value) {
    const text = value?.trim();
    return !!text && (originalControl.test(text) || hasAttribution(text));
  }

  function visibilityAffectsLanguage(el) {
    if (el.closest('svg,[data-testid="tweetPhoto"],[data-testid="card.wrapper"],[data-testid="socialContext"]')) return false;
    return el.matches(visibilityEvidence) || el.querySelector(visibilityEvidence) !== null ||
      !!el.closest('[data-testid="User-Name"]') || /translat|original/i.test(el.textContent);
  }

  function displaysTranslation(article) {
    // A native translation may replace the original or appear underneath it.
    // Ignore user-authored prose, profile names, cards and hidden templates.
    const ignored = '[data-testid="User-Name"],[data-testid="card.wrapper"],[data-testid="socialContext"],[data-testid="tweetPhoto"],[hidden],[aria-hidden="true"]';
    const excludedText = bodySelector + "," + ignored;
    for (const panel of article.querySelectorAll(translationPanel)) {
      if (panel.closest(ignored) || panel.parentElement.closest(bodySelector)) continue;
      const body = panel.matches(bodySelector + ',[data-testid="translatedTweetText"],[data-slot="translated-text"]') ? panel : panel.querySelector(bodySelector);
      if (body && !body.closest(ignored) && body.textContent.trim()) return true;
    }
    const actions = 'button,[role="button"],a';
    for (const el of article.querySelectorAll(actions + ',[aria-label]')) {
      if (el.closest(excludedText)) continue;
      if (el.matches('a[href]:not([href^="#"])') &&
          (/^\/\w+\/?$/.test(el.pathname) || el.pathname?.includes("/status/"))) continue;
      const label = el.getAttribute("aria-label")?.trim() || "";
      if (hasAttribution(label)) return true;
      if (!el.matches(actions)) continue;
      const text = el.textContent.trim().replace(/\s+/g, " ");
      if (originalControl.test(label) || originalControl.test(text) || hasAttribution(text)) return true;
    }
    // The attribution can be plain text, with the language or provider in a
    // separate inline element. Inspect its enclosing label only on a text hit.
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!/^(?:auto[- ]?)?translated\b/i.test(node.data.trimStart())) continue;
      const parent = node.parentElement;
      if (parent.closest(excludedText + ",a[href],script,style")) continue;
      if (hasAttribution(node.data.trim())) return true;
      for (let el = parent; el && el !== article; el = el.parentElement) {
        const text = el.textContent.trim().replace(/\s+/g, " ");
        if (text.length > 100 || el.querySelector(bodySelector)) break;
        if (hasAttribution(text)) return true;
      }
    }
    return false;
  }
  function permalink(value, postIds) {
    if (!value) return null;
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin) return null;
      const match = /^\/(\w{1,15}|i\/web)\/status\/(\d{1,20})\/?$/i.exec(url.pathname);
      if (match) postIds?.add(match[2]);
      const handle = match?.[1].toLowerCase();
      return handle && handle !== "i" && handle !== "i/web" ? handle : null;
    } catch { return null; }
  }
  function quoteRoots(article) {
    return [...article.querySelectorAll(quoteSelector)].filter(el =>
      !el.matches('[role="link"]') || el.matches('[data-slot="embedded-tweet-frame"],[data-testid="quoteTweet"]') ||
      !!el.querySelector('[data-testid="User-Name"], [data-testid="tweetText"]') ||
      [...el.querySelectorAll('span')].some(span => handlePattern.test(span.textContent.trim()))
    ).filter(el => !el.closest('[data-testid="card.wrapper"]') &&
      !(el.matches("article") && el.parentElement.closest('[data-slot="embedded-tweet-frame"]')));
  }
  function author(root, within, quote, byline, postIds) {
    const handles = new Set();
    function addPermalink(value) {
      const name = permalink(value, postIds);
      if (name) handles.add(name);
    }
    addPermalink(root.getAttribute("data-href") || root.getAttribute("href"));
    if (!quote && root.parentElement?.matches('[role=link][data-href]')) addPermalink(root.parentElement.dataset.href);
    for (const link of root.querySelectorAll("a[href]")) {
      if (within(link) && !link.closest(bodySelector + ',[data-testid="socialContext"],[data-testid="card.wrapper"]'))
        addPermalink(link.getAttribute("href"));
    }
    const identity = byline || (!handles.size && quote ? root : null);
    for (const node of identity?.querySelectorAll("span") || []) {
      if (!within(node) || node.closest(bodySelector)) continue;
      const name = handlePattern.exec(node.textContent.trim());
      if (name) handles.add(name[1].toLowerCase());
    }
    return handles.size === 1 ? handles.values().next().value : null;
  }
  function displayName(root, byline, handle, within) {
    // Classic X groups the name, handle and timestamp. The newer client
    // puts the display name in a separate link to the author's profile.
    for (const link of (byline || root).querySelectorAll("a[href]")) {
      if (!within(link) || link.origin !== location.origin ||
          !/^\/\w{1,15}\/?$/.test(link.pathname) ||
          (handle && link.pathname.split("/")[1].toLowerCase() !== handle) ||
          (!handle && !byline) ||
          link.closest(bodySelector + ',[data-testid="socialContext"],[data-testid="card.wrapper"],[role="button"]')) continue;
      const text = link.textContent.trim();
      if (text && !handlePattern.test(text)) return text;
    }
    // Compact bylines sometimes render the name without its own link.
    if (byline) {
      const name = byline.cloneNode(true);
      name.querySelectorAll('a,time,button,[role="button"],svg,[aria-hidden="true"]').forEach(el => el.remove());
      return name.textContent.trim();
    }
    return "";
  }
  const sentences = new Intl.Segmenter(undefined, {granularity:"sentence"});
  function startsInCaps(text) {
    const prose = text.replace(/(?:https?:\/\/|www\.)[^\s]+|@[\w]+/gi, " ").trim();
    // Keep dotted initialisms and titles with the words they introduce.
    // Social posts also start follow-up sentences with lowercase letters.
    const forSegmentation = prose
      .replace(/\.{3,}/g, "…")
      .replace(/\b(?:(?:[A-Z]\.){2,}|(?:MR|MRS|MS|DR|PROF|ST|MT|FT|JR)\.)(?=[ \t]+[\p{L}&/])/gu, token => token.replaceAll(".", "·"))
      .replace(/(?<![\p{L}\p{N}])\p{Lu}\.(?=[ \t]+\p{Lu}[\p{Ll}.])/gu, token => token.replace(".", "·"))
      .replace(/\.[ \t]+(?=\p{Lowercase})/gu, ".\n");
    for (const {segment} of sentences.segment(forSegmentation)) {
      if (!/[\p{L}\p{N}]/u.test(segment)) continue;
      return /\p{Lu}/u.test(segment) && !/(?!\p{Uppercase})\p{L}/u.test(segment);
    }
    return false;
  }
  function bodyText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button,[role="button"],script,style,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
    for (const link of clone.querySelectorAll("a[href]")) {
      const label = link.textContent.trim();
      if (/^(?:https?:|www\.|@)/i.test(label) || /^(?:[\w-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i.test(label) || link.hostname === "t.co")
        link.replaceWith(" ");
    }
    clone.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
    for (const block of clone.querySelectorAll("div,p")) {
      block.before("\n");
      block.after("\n");
    }
    return clone.textContent.trim();
  }
  function read(article, includeBodies = true, checkCaps = false) {
    const translated = includeBodies && displaysTranslation(article);
    let capsOpening = false;
    const quotes = quoteRoots(article);
    const authors = [];
    const bodies = [];
    const postIds = new Set();
    for (const root of [article, ...quotes]) {
      const within = el => !quotes.some(q => q !== root && root.contains(q) && q.contains(el));
      const byline = [...root.querySelectorAll('[data-testid="User-Name"]')].find(within);
      const handle = author(root, within, root !== article, byline, root === article ? postIds : null);
      const id = linkedUserId(byline,handle);
      authors.push(id ? handle+"@"+id : handle);
      let readLanguage = includeBodies && !translated;
      let readOpening = checkCaps && root === article;
      if (!readLanguage && !readOpening) continue;
      if (readLanguage) {
        const name = displayName(root, byline, handle, within);
        if (name) bodies.push(["", name]);
      }
      for (const el of root.querySelectorAll(bodySelector + (root !== article ? ',[dir="auto"][lang]' : ''))) {
        if (!within(el) || el.closest('[data-testid="card.wrapper"],[data-testid="User-Name"],[data-testid="socialContext"],[hidden],[aria-hidden="true"]') ||
            el.parentElement.closest(bodySelector)) continue;
        const languageBody = readLanguage && !el.closest(translationPanel);
        if (!languageBody && !readOpening) continue;
        const text = bodyText(el);
        if (!text) continue;
        if (languageBody) {
          bodies.push([el.lang, text]);
          readLanguage = false;
        }
        if (readOpening) {
          capsOpening = startsInCaps(text);
          readOpening = false;
        }
        if (!readLanguage && !readOpening) break;
      }
    }
    return { authors: [...new Set(authors)], bodies, translated, capsOpening, id: postIds.size === 1 ? postIds.values().next().value : null };
  }
  // Test letters only. Digits, punctuation, emoji and combining marks do not
  // establish a writing system, and names can be a single letter in a script.
  const nonLatinLetter = /(?![\p{Script=Latin}\p{Script=Common}])\p{L}/u;
  const phrases = /\b(?:muchas gracias|hola (?:mundo|amigos)|qu[eé] tal|tout le monde|buenos d[ií]as|buenas noches|merci beaucoup|je suis|vielen dank|guten morgen|muito obrigad[oa]|grazie mille)\b/iu;
  async function nonEnglish(bodies) {
    for (const [lang, body] of bodies) {
      const text = body.replace(/(?:https?:\/\/|www\.)\S+|@[\w]+|\b(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?/gi, " ").trim();
      if (!/\p{L}/u.test(text)) continue;
      if (nonLatinLetter.test(text) || phrases.test(text)) return true;
      const wordsInBody = text.match(/\p{L}+/gu) || [];
      const tagged = /^[a-z]{2,3}(?:-|$)/i.test(lang) && !unknownLang.test(lang);
      if (tagged && (wordsInBody.length >= 2 ||
          /^(?:bonjour|bonsoir|gracias|gràcies|obrigad[oa]|danke|grazie|salut|hola|merci)[!.?]*$/iu.test(text))) return true;
      const samples = new Set([text, ...text.split(/[.!?;:\n。！？]+/u)]);
      // Overlapping windows can expose a language switch without punctuation.
      const words = text.split(/\s+/);
      if (words.length >= 12) {
        for (let i = 0; i + 5 < words.length; i += 6) samples.add(words.slice(i, i + 10).join(" "));
      }
      const segments = [...samples];
      const step = Math.max(1, Math.ceil(segments.length / 32));
      for (let i = 0; i < segments.length; i += step) {
        const sample = segments[i];
        if ((sample.match(/\p{L}/gu) || []).length < 16 || sample.trim().split(/\s+/).length < 4) continue;
        const result = await chrome.i18n.detectLanguage(sample).catch(() => null);
        if (result?.isReliable && result.languages.some(l => !unknownLang.test(l.language) && l.percentage >= 15)) return true;
      }
    }
    return false;
  }
  function containsBodyText(el) {
    return !!(el.closest(bodySelector) || el.querySelector(bodySelector));
  }
  return { read, nonEnglish, visibilityAffectsLanguage, isTranslationLabel, containsBodyText };
})();

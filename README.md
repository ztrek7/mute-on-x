# Mute on X

**[Download Mute on X 1.8.2 for Brave or Chromium](https://github.com/ztrek7/mute-on-x/releases/download/v1.8.2/mute-on-x-1.8.2.zip)**

1. Download the ZIP and unzip it into a folder you’ll keep.
2. Open `brave://extensions` in Brave or `chrome://extensions` in Chromium. Turn on **Developer mode**.
3. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
4. Refresh your open x.com tabs. To update an unpacked installation, replace the files in the same folder, click **Reload** on the extension card, and refresh each open X tab so it runs the updated filters and counter.

## Mute a word or phrase

Right-click a word on x.com, or select a phrase and right-click it. Choose **Mute on X** while signed in.

- **If a new X tab opens**, you’ll see **Add muted word** with your selection filled in. Review the word, where to mute it, and for how long. Click **Save** in X to confirm. Closing the tab before saving cancels this mute. Your original feed stays open.
- **If you stay on the feed**, look for the confirmation there. When the extension can read your muted-word list directly, it checks for duplicates and verifies a new mute after saving. On this path it requests the Home timeline, replies, and notifications from anyone, with no expiration.

You can change or remove a mute in [X’s muted-word settings](https://x.com/settings/muted_keywords).

## Feed filters

Open **Mute on X** from the extensions menu. All filters start off.

- **Hide posts from non-US accounts** checks X’s “Account based in” label for the author and quoted author. A confirmed non-US result hides the whole post. Unknown or pending locations stay visible unless you enable **Also hide unverified locations**. Checks can pause when X limits access. A new feed can appear empty in the stricter mode.
- **Hide identifiable non-English text** checks post and quoted text, visible translation indicators, and non-Latin letters in author names. Short or mixed passages can be misclassified.
- **Hide posts that open in ALL CAPS** checks the first sentence of the post’s own text.
- **Hide repeated lines or sentences** checks for three occurrences of the same whole line or sentence in one post. Each must have at least three words, two different words and 12 letters, excluding handles and URLs from those minimums. Case, extra whitespace and trailing sentence punctuation are ignored. Soft line wrapping does not create a new line.
- **Hide alert-style headlines** hides posts beginning with 🚨, even on its own, or with a heading such as “BREAKING:”, “JUST IN:”, “BREAKING NEWS:” or “NEWS ALERT:”. A heading can also end at a dash or occupy its own line. Hashtags and native emoji are supported. The rule can hide genuine news.

These two switches work independently on the post’s own text in your browser. They skip bylines, quoted posts and link previews. They make no requests and do not compare posts across accounts.

The toolbar counts each identified outer post once per browser session, even across tabs and overlapping filters. In strict location mode, a completed lookup with a missing label counts. Pending lookups and temporary service failures can hide a row while the count waits. If the outer post has no unambiguous status link, it stays filtered and counts only if its link appears while it still matches. The popup includes the regular profile’s all-time count. Private windows have a separate session count. Filtering changes what you see locally. The mute command changes your X account.

The extension uses a Chromium 130+ API. X can change its web service, reject a request or ask you to verify your session. If a save is unconfirmed, check your muted words before trying again. For data use, prerequisites, tests and release checksum instructions, see the [privacy policy](distribution/listing/privacy.html) and [developer guide](DEVELOPING.md).

Mute on X is available under the [MIT License](LICENSE). Third-party dependencies retain their own licenses.

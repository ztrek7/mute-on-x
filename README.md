# Mute on X

**[Download Mute on X 1.7.0 for Brave or Chromium](https://github.com/ztrek7/mute-on-x/releases/download/v1.7.0/mute-on-x-1.7.0.zip)**

1. Download the ZIP and unzip it into a folder you’ll keep.
2. Open `brave://extensions` in Brave or `chrome://extensions` in Chromium. Turn on **Developer mode**.
3. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
4. Refresh your open x.com tabs. To update an unpacked installation, replace the files in the same folder, click **Reload** on the extension card, and refresh X.

## Mute a word or phrase

On a signed-in X page, right-click a word or select a phrase and choose **Mute on X**. The extension checks your account’s muted words, submits one save from the current page, and reads the list again. A confirmation appears on the page once X lists the term. Your tab and reading position stay in place.

New entries request **Home timeline, replies and notifications from anyone, forever**. These are the extension’s defaults. Existing entries keep their settings. You can change the scope or duration, remove a word, or check an unconfirmed save in [X’s muted-word settings](https://x.com/settings/muted_keywords).

## Feed filters

Open **Mute on X** from the extensions menu. All filters start off.

- **Hide posts from non-US accounts** checks X’s “Account based in” label for the author and quoted author. A confirmed non-US result hides the whole post. Unknown or pending locations stay visible unless you enable **Also hide unverified locations**. Checks can pause when X limits access. A new feed can appear empty in the stricter mode.
- **Hide identifiable non-English text** checks post and quoted text, visible translation indicators, and non-Latin letters in author names. Short or mixed passages can be misclassified.
- **Hide posts that open in ALL CAPS** checks the first sentence of the post’s own text.

The toolbar shows how many identified posts the filters have hidden this session. The popup includes the regular profile’s all-time count. Private windows have a separate session count. Filtering changes what you see locally. The mute command changes your X account.

The extension uses a Chromium 130+ API. X can change its web service, reject a request or ask you to verify your session. If a save is unconfirmed, check your muted words before trying again. For data use, prerequisites, tests and release checksum instructions, see the [privacy policy](distribution/listing/privacy.html) and [developer guide](DEVELOPING.md).

Mute on X is available under the [MIT License](LICENSE). Third-party dependencies retain their own licenses.

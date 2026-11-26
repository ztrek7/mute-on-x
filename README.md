# Mute on X

Right-click a word on X, or select a phrase and choose **Mute on X**. The extension opens X’s muted-word settings in an inactive tab, saves the term with the options already set on the form, and checks the reloaded list. The original tab shows the result. You can edit or remove the term later in X’s settings.

## Install locally

1. Use a desktop Chromium-based browser with extension support, such as Brave. Open the Extensions page and enable **Developer mode**.
2. Choose **Load unpacked** and select the `extension/` directory in this checkout. If you have a release ZIP, extract it first and select the directory containing `manifest.json`.
3. Refresh any open x.com tabs. To use the mute command, sign in to X. To update an unpacked installation, replace the files in the same directory, click **Reload** on the extension card, and refresh X.

## Feed filters

Open **Mute on X** from the extensions menu. All filters start off.

- **Hide posts from non-US accounts** checks X’s “Account based in” label for the author and quoted author. A confirmed non-US result hides the whole post. Unknown or pending locations stay visible unless you enable **Also hide unverified locations**. Checks can pause when X limits access. A new feed can appear empty in the stricter mode.
- **Hide identifiable non-English text** checks post and quoted text, visible translation indicators, and non-Latin letters in author names. Short or mixed passages can be misclassified.
- **Hide posts that open in ALL CAPS** checks the first sentence of the post’s own text.

The toolbar shows how many identified posts the filters have hidden this session. The popup includes the regular profile’s all-time count. Private windows have a separate session count. Filtering changes what you see locally. The mute command changes your X account.

The extension uses a Chromium 130+ API. Its page automation looks for English controls and can stop working when X changes its pages or its location lookup. For data use, prerequisites, tests and release checksum instructions, see the [privacy policy](distribution/listing/privacy.html) and [developer guide](DEVELOPING.md).

Mute on X is available under the [MIT License](LICENSE). Third-party dependencies retain their own licenses.

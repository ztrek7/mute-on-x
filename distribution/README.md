# Mute on X distribution

Build the current release from the checkout root with `npm run package` and check its contents with `npm run verify:package`. The unsigned ZIP and SHA-256 checksum are in `dist/`. The ZIP contains the extension runtime. Listing text and the privacy page are maintained here. [Build and test instructions](../DEVELOPING.md)

Supply the publisher’s verified contact details. Host the [privacy policy](listing/privacy.html) at a publicly accessible HTTPS URL, enter it on the Privacy tab, and review and certify the data disclosures. The policy describes muted-word submission, the optional feed filters, the ct0 cookie used for the mute and location requests as X’s CSRF header, X-only network use, and the filter and count data stored in the browser. All executable code is in the package. [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

**Listing description**

Right-click a word on x.com or select a phrase and choose **Mute on X**. From the current page, the extension checks your signed-in account’s list, saves new entries for the Home timeline, replies and notifications from anyone, and checks the updated list. The mute lasts until you change or remove it in X’s settings. The result appears on the original page without opening another tab.

The popup can also hide posts from non-US accounts, hide unverified locations, hide identifiable non-English text, and hide posts that open in all caps. Those filters stay off until you enable them. Language and all-caps checks stay in the page. The country filter requests account-location labels from X with your existing sign-in.

**Single purpose and permissions**

Mute on X lets you mute a word you choose and optionally hide feed posts by account location, language, or an all-caps opening. The context-menu permission supplies the mute command. Storage keeps the filter switches, block counts, paced-request timestamps, and location results described in the privacy policy. Page scripts run on https://x.com/. The mute command uses the current document’s X session and CSRF cookie to send the selected term and options to X. The optional country filter also uses that session and cookie to retrieve location labels from X. The extension does not operate its own collection service.

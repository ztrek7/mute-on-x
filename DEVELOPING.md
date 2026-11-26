# Development

The Manifest V3 runtime is plain JavaScript, HTML and CSS in `extension/`. Load it directly for development. No JavaScript build or runtime dependencies are required. The manifest sets a Chromium 130 API floor because the service worker uses `chrome.storage.session.getKeys()` during startup. The browser version used by the tests can be newer. [Chrome StorageArea reference](https://developer.chrome.com/docs/extensions/reference/api/storage/StorageArea#method-getKeys)

## Tests

Use Node.js 20 or later, npm and OpenSSL on PATH. From the checkout root, install the locked development dependencies and Playwright’s matching full Chromium browser. The browser download and npm install require internet access or a populated cache. Linux also needs Chromium’s shared libraries.

```sh
npm ci
npx playwright install chromium
npm test
```

Set `BROWSER_BIN` to the absolute executable path of an extension-capable desktop Chromium or Brave build to test that build. The default is the full browser installed for the pinned Playwright version. Set `EXTENSION_DIR` to the extracted release directory to run the fixture against a specific archive. Each browser run uses a fresh profile, a generated loopback TLS certificate and local X-shaped fixture pages. Host resolution maps the two X endpoints to the fixture and rejects other hostnames. The suite exercises English-language controls. Headless tests dispatch the context-menu handler directly.

For the actual browser menu and worker wakeup, run `npm run test:native` on Linux with Python 3, Xvfb and xvfb-run, xauth, X11 and XTest libraries, ImageMagick’s `import`, Tesseract with English data, and working fonts. The test opens its own virtual display. The private-window scenario enables incognito access only in its temporary profile. Examples of focused runs:

```sh
node tests/fixture.cjs --review=caps
node tests/fixture.cjs --review=private-stats
node tests/fixture.cjs --review=background-feed
```

The fixtures verify simulated X responses. Live signed-in muting, account-location access, and store installation require separate verification.

## Package

Use Git and Python 3.9+ from a checkout with a committed `extension/` tree and root `LICENSE`. The commands below also work directly as `python3 scripts/package.py` and `python3 scripts/package.py --check`.

```sh
npm run package
npm run verify:package
```

The packager reads Git objects from HEAD, uses the manifest version in the filename, and writes an unsigned ZIP and SHA-256 sidecar under `dist/`. It rejects staged or unstaged changes to tracked extension files or the project license. Each ZIP contains the tracked runtime and a verbatim copy of the root `LICENSE`. ZIP entries use sorted names, fixed metadata and stored bytes for reproducibility. Verification compares the complete archive and checksum against a fresh reconstruction. To install the candidate, extract the ZIP in an empty directory and load that directory as unpacked. The publisher-facing listing and privacy policy live in `distribution/`.

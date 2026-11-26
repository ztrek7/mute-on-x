// Only an account navigation control can identify the signed-in viewer.
const profileLinks = 'a[data-testid="AppTabBar_Profile_Link"],nav a[aria-label="Profile" i],[role=navigation] a[aria-label="Profile" i]';
const accountSwitcher = '[data-testid="SideNav_AccountSwitcher_Button"]';

function feedViewer() {
  const handles = new Set();
  for (const link of document.querySelectorAll(profileLinks)) {
    if (!link.checkVisibility() || link.closest("article") || link.origin !== location.origin) continue;
    const match = /^\/(\w{1,15})\/?$/.exec(link.pathname);
    if (match && !/^(?:profile|home|i)$/i.test(match[1])) handles.add(match[1].toLowerCase());
  }
  const menu = document.querySelector(accountSwitcher);
  if (menu?.checkVisibility() && !menu.closest("article")) {
    for (const name of menu.innerText.match(/@[a-z\d_]{1,15}\b/gi) || []) handles.add(name.slice(1).toLowerCase());
  }
  return handles.size === 1 ? [...handles][0] : null;
}

// A native numeric profile link names an account. A status ID names a post.
function linkedUserId(root, handle) {
  if (!root || !handle) return null;
  const ids = new Set();
  for (const link of root.querySelectorAll("a[href*=\"/i/user/\"]")) {
    if (link.origin !== location.origin || link.textContent.trim().toLowerCase() !== "@" + handle) continue;
    const id = /^\/i\/user\/(\d{1,20})\/?$/.exec(link.pathname)?.[1];
    if (id) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

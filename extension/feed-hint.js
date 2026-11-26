// In-flow text outside the virtual list. Never allocate a row for a post.
const emptyFeedHint = (() => {
  let host, line, more;
  function update(main, text, canContinue, advance, showLocationsHere) {
    if (!main || !text) {
      host?.remove();
      return;
    }
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("data-mox-empty-feed", "");
      const root = host.attachShadow({mode: "open"});
      root.innerHTML =
        "<style>:host{display:block;color:inherit;background:transparent;font:14px/1.45 system-ui}div{padding:6px 12px}button{font:inherit;color:inherit;text-decoration:underline;border:0;background:transparent;padding:2px 5px;cursor:pointer}</style><div><span role=\"status\"></span> <button type=\"button\">Show all locations until reload</button><button type=\"button\">Check more posts</button></div>";
      line = root.querySelector("span");
      const buttons = root.querySelectorAll("button");
      buttons[0].onclick = event => {
        if (event.isTrusted) showLocationsHere();
      };
      more = buttons[1];
      more.onclick = event => { if (event.isTrusted) advance(); };
    }
    if (line.textContent !== text) line.textContent = text;
    more.hidden = !canContinue;
    if (host.parentElement !== main) {
      const header = main.querySelector(":scope > header,:scope > [role=banner]");
      if (header)
        header.after(host);
      else
        main.prepend(host);
    }
  }
  return {update};
})();

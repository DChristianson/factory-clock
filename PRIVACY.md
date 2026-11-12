# Privacy

Factory Clock is a static page on GitHub Pages: <https://dchristianson.github.io/factory-clock/>. This page says what it does with your data.

## What the page reads

By default the page draws generated example sessions that are built into it. They were not recorded from anyone.

It can also load event files you choose, such as the daily files Snagboat writes (`events/YYYY-MM-DD.jsonl`). In VS Code, **Snagboat: Reveal Event Log Folder** opens the folder they are in. The page reads the files in your browser. Loaded events stay in the page's memory until you close or reload the tab. They are never uploaded.

## What the page sends

Nothing. The page's Content-Security-Policy is:

```text
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'
```

So a script on the page cannot make a network request, even by mistake. Scripts and styles load only from the page's own site. There are no analytics, no service worker, no third-party scripts, no web fonts, and no cookies.

## What the page stores

Only the explorer's view state, in your browser's local storage under the key `factoryClock.explore`. It holds the picked session ids, the current view, its filters, the replay settings, the puck's position, and the current selection. It holds no events and no text from your files. Clearing the site's data in your browser removes it.

## What GitHub sees

GitHub serves the page and sees the request for it, as for any site. It sees none of the files you load.

## Running it yourself

A copy you build with `npm run build` and open from `site/` behaves the same way. The policy is in the page itself (`hosts/web/index.html`), and the Pages workflow deploys the files as built.

# Privacy

Factory Clock is a static page on GitHub Pages: <https://dchristianson.github.io/factory-clock/>. This page says what it does with your data.

## What the page reads

By default the page draws generated example sessions that are built into it. They were not recorded from anyone.

It can also load event files you choose, such as the daily files Snagboat writes (`events/YYYY-MM-DD.jsonl`). In VS Code, **Snagboat: Reveal Event Log Folder** opens the folder they are in. The page reads the files in your browser. Loaded events stay in the page's memory until you close or reload the tab. They are never uploaded.

## What the page sends

Only a page view to Google Analytics, and only from the published page at `dchristianson.github.io`. Nothing you load is in it.

When you open the published page, it loads Google's analytics tag (`gtag.js`) from `www.googletagmanager.com`, which sends one page view to Google Analytics. The tag is in [`hosts/web/analytics.js`](hosts/web/analytics.js). It's the same Google Analytics stream as the owner's other GitHub Pages sites. The page view carries:

- the page's address, without any query or hash (`https://dchristianson.github.io/factory-clock/`), and its title
- the referring page, if your browser sends one
- what Google's tag collects about any visit: browser, device, screen size, language, and a rough location that Google works out from your IP address

Google signals and ad personalization are turned off. The sessions, code, and plans you load are never sent, to Google or anywhere else, because the page never puts them in its address, its title, or any request. Google's own terms cover what Google does with the page view: <https://policies.google.com/privacy>.

The page's Content-Security-Policy is:

```text
default-src 'none'; script-src 'self' https://www.googletagmanager.com; style-src 'self'; img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com; connect-src https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com; base-uri 'none'; form-action 'none'
```

So scripts load only from the page's own site and Google's tag host. A script on the page can make network requests only to Google Analytics, even by mistake. There is no service worker, no other third-party script, no web fonts, and no other cookies.

**Cookies.** Google Analytics sets two first-party cookies on `dchristianson.github.io`, `_ga` and `_ga_<stream>`. They hold a random id that tells repeat visits apart, and they last up to two years.

**To opt out**, block `googletagmanager.com` or `google-analytics.com` (most content blockers do), or use Google's opt-out add-on: <https://tools.google.com/dlpage/gaoptout>. The page works the same without it.

## What the page stores

Besides Google Analytics' cookies, only the explorer's view state, in your browser's local storage under the key `factoryClock.explore`. It holds the picked session ids, the current view, its filters, the replay settings, the puck's position, and the current selection. It holds no events and no text from your files. Clearing the site's data in your browser removes it.

## What GitHub and Google see

GitHub serves the page and sees the request for it, as for any site. Google sees the page view described above. Neither sees the files you load.

## Running it yourself

A copy you build with `npm run build` and open from `site/` (or serve from anywhere but `dchristianson.github.io`, a fork's own Pages included) loads no analytics and sends nothing. The policy is in the page itself (`hosts/web/index.html`), and the Pages workflow deploys the files as built.

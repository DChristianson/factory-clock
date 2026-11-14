// Google Analytics, on the published page only: the same stream as the
// owner's other GitHub Pages sites. It counts page views. A copy served from
// anywhere else (a local build, file://, a fork's own Pages) loads nothing
// and sends nothing.
//
// What it sends is the page's address without its query or hash, its title,
// and what Google's tag collects about the visit (browser, screen, rough
// location from the IP address). Nothing you load into the page is in it:
// the page never puts loaded data in its address or title. Google signals
// and ad personalization are off. See PRIVACY.md.
(function () {
  if (location.hostname !== 'dchristianson.github.io') return;
  const id = 'G-7PSQ7XN3RG';
  const tag = document.createElement('script');
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
  document.head.appendChild(tag);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  window.gtag('config', id, {
    page_location: location.origin + location.pathname,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
})();

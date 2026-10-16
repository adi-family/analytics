// ADI's site snippet. No dependencies, nothing automatic beyond one page_view per load.
//
//   <script async src="https://relay.withadi.dev/web.js" data-consent="false"></script>
//
//   adi.send(name, props)   send one allowlisted event
//   adi.link(id)            link this browser to a known id (needs consent)
//   adi.consent(bool)       the banner's answer; true sets the adi_id cookie, false deletes it
//
// Before consent nothing is stored in the browser and events go out without any id, so
// they cannot be joined. With Do-Not-Track or Global Privacy Control on, nothing is sent.
// data-endpoint, data-cookie-domain and data-pageview="false" override the defaults.
//
// Requests use fetch(keepalive), never navigator.sendBeacon: EasyPrivacy blocks every
// third-party beacon (*$ping,third-party), and uBlock Origin on Firefox sees this host as
// third party once it resolves the CNAME to API Gateway.
(function (w, d) {
  var script = d.currentScript;
  var attr = function (n, dflt) {
    var v = script && script.getAttribute("data-" + n);
    return v == null ? dflt : v;
  };
  var base = attr("endpoint", script ? new URL(script.src).origin : "");
  var domain = attr("cookie-domain", ".withadi.dev");
  var nav = w.navigator;
  var off = nav.globalPrivacyControl === true || nav.doNotTrack === "1" || w.doNotTrack === "1";
  var BID = "adi_id", KID = "adi_link", YEAR = 31536000;
  var queue = [], timer = 0;

  var readCookie = function (n) {
    var m = d.cookie.match(new RegExp("(?:^|; )" + n + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  };
  var writeCookie = function (n, v, age) {
    d.cookie = n + "=" + encodeURIComponent(v) + "; Max-Age=" + age + "; Path=/; Domain=" + domain + "; SameSite=Lax" +
      (w.location.protocol === "https:" ? "; Secure" : "");
  };
  var uuid = function () {
    return w.crypto.randomUUID();
  };
  // text/plain keeps this a "simple" request: no CORS preflight.
  var post = function (path, body) {
    w.fetch(base + path, { method: "POST", body: JSON.stringify(body), keepalive: true, credentials: "omit", headers: { "content-type": "text/plain" } })
      .catch(function () {});
  };

  // Consent lives in the page's banner; the snippet only remembers it for this page view
  // and through the presence of the cookie.
  var consented = !off && (attr("consent", "") === "true" || readCookie(BID) !== null);
  var bid = consented ? readCookie(BID) : null;
  var kid = consented ? readCookie(KID) : null;

  var flush = function () {
    clearTimeout(timer);
    timer = 0;
    while (queue.length) {
      var body = { consent: consented, items: queue.splice(0, 50) };
      if (consented) {
        body.browser_id = bid;
        if (kid) body.known_id = kid;
      }
      post("/v1/web", body);
    }
  };

  var api = {
    send: function (name, props) {
      if (off) return;
      queue.push({ name: name, props: props || {}, at: new Date().toISOString(), id: uuid() });
      if (!timer) timer = setTimeout(flush, 1000);
    },
    link: function (id) {
      if (off || !consented || !id) return;
      kid = String(id);
      writeCookie(KID, kid, YEAR);
      post("/v1/link", { consent: true, browser_id: bid, known_id: kid });
    },
    consent: function (yes) {
      flush(); // whatever was queued goes out under the old answer
      consented = !!yes && !off;
      if (consented) {
        bid = readCookie(BID) || uuid();
        writeCookie(BID, bid, YEAR);
      } else {
        bid = kid = null;
        writeCookie(BID, "", 0);
        writeCookie(KID, "", 0);
      }
    },
    // page_view's properties: the path without query string, utm_* when present, and the
    // referring domain only (never the full referrer URL).
    page: function () {
      var loc = w.location, q = new URLSearchParams(loc.search), p = { path: loc.pathname || "/" };
      ["utm_source", "utm_medium", "utm_campaign"].forEach(function (k) {
        var v = q.get(k);
        if (v) p[k] = v.slice(0, 200);
      });
      try {
        var ref = d.referrer && new URL(d.referrer).hostname;
        if (ref && ref !== loc.hostname) p.referring_domain = ref.toLowerCase();
      } catch (e) {}
      api.send("page_view", p);
    },
  };

  // Calls made before the snippet loaded: window.adi = window.adi || {q: []}; adi.q.push(["send", ...])
  var pending = (w.adi && w.adi.q) || [];
  w.adi = api;
  if (consented && !bid) api.consent(true);
  w.addEventListener("pagehide", flush);
  if (attr("pageview", "true") !== "false") api.page();
  for (var i = 0; i < pending.length; i++) api[pending[i][0]] && api[pending[i][0]].apply(api, pending[i].slice(1));
})(window, document);

// ADI analytics snippet. No dependencies, no autocapture beyond one page_view per load.
//
//   <script async src="https://t.withadi.dev/a.js" data-consent="false"></script>
//
//   adi.track(name, props)   send one allowlisted event
//   adi.identify(id)         link this browser to a known id (needs consent)
//   adi.consent(bool)        the banner's answer; true sets the adi_aid cookie, false deletes it
//
// Before consent nothing is stored in the browser and events go out without any id, so
// they cannot be joined. With Do-Not-Track or Global Privacy Control on, nothing is sent.
// data-endpoint, data-cookie-domain and data-pageview="false" override the defaults.
(function (w, d) {
  var script = d.currentScript;
  var attr = function (n, dflt) {
    var v = script && script.getAttribute("data-" + n);
    return v == null ? dflt : v;
  };
  var endpoint = attr("endpoint", script ? new URL(script.src).origin : "") + "/e";
  var domain = attr("cookie-domain", ".withadi.dev");
  var nav = w.navigator;
  var off = nav.globalPrivacyControl === true || nav.doNotTrack === "1" || w.doNotTrack === "1";
  var AID = "adi_aid", DID = "adi_did", YEAR = 31536000;
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

  // Consent lives in the page's banner; the snippet only remembers it for this page view
  // and through the presence of the cookie.
  var consented = !off && (attr("consent", "") === "true" || readCookie(AID) !== null);
  var aid = consented ? readCookie(AID) : null;
  var did = consented ? readCookie(DID) : null;

  var flush = function () {
    clearTimeout(timer);
    timer = 0;
    if (!queue.length) return;
    var body = { consent: consented, events: queue.splice(0, 50) };
    if (consented) {
      body.anonymous_id = aid;
      if (did) body.distinct_id = did;
    }
    var data = JSON.stringify(body);
    // text/plain keeps this a "simple" request: no CORS preflight.
    if (!(nav.sendBeacon && nav.sendBeacon(endpoint, new Blob([data], { type: "text/plain" })))) {
      w.fetch(endpoint, { method: "POST", body: data, keepalive: true, credentials: "omit", headers: { "content-type": "text/plain" } })
        .catch(function () {});
    }
    if (queue.length) flush();
  };

  var api = {
    track: function (name, props) {
      if (off) return;
      queue.push({ event: name, properties: props || {}, ts: new Date().toISOString(), id: uuid() });
      if (!timer) timer = setTimeout(flush, 1000);
    },
    identify: function (id) {
      if (off || !consented || !id) return;
      did = String(id);
      writeCookie(DID, did, YEAR);
      w.fetch(endpoint.replace(/\/e$/, "/identify"), {
        method: "POST", keepalive: true, credentials: "omit", headers: { "content-type": "text/plain" },
        body: JSON.stringify({ consent: true, anonymous_id: aid, distinct_id: did }),
      }).catch(function () {});
    },
    consent: function (yes) {
      flush(); // whatever was queued goes out under the old answer
      consented = !!yes && !off;
      if (consented) {
        aid = readCookie(AID) || uuid();
        writeCookie(AID, aid, YEAR);
      } else {
        aid = did = null;
        writeCookie(AID, "", 0);
        writeCookie(DID, "", 0);
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
      api.track("page_view", p);
    },
  };

  // Calls made before the snippet loaded: window.adi = window.adi || {q: []}; adi.q.push(["track", ...])
  var pending = (w.adi && w.adi.q) || [];
  w.adi = api;
  if (consented && !aid) api.consent(true);
  w.addEventListener("pagehide", flush);
  if (attr("pageview", "true") !== "false") api.page();
  for (var i = 0; i < pending.length; i++) api[pending[i][0]] && api[pending[i][0]].apply(api, pending[i].slice(1));
})(window, document);

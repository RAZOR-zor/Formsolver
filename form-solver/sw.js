/* Form Solver - sw.js (service worker)
 * 1) Klik icon toolbar = tampilkan/sembunyikan widget dalam halaman form.
 * 2) PROXY API (bypass CORS).
 *    Content script berjalan pada origin docs.google.com, jadi fetch cross-origin
 *    tunduk aturan CORS browser. api.xkiro.com tidak mengirim header
 *    Access-Control-Allow-Origin dan OPTIONS preflight-nya 404, sehingga browser
 *    memblokir request -> "TypeError: Failed to fetch".
 *    Fetch dari service worker memakai origin extension + host_permissions (manifest),
 *    sehingga CORS tidak berlaku di sini.
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_WIDGET" });
  } catch (e) { /* bukan halaman form / widget belum siap: abaikan */ }
});

// ---- proxy fetch ----
var inflight = new Map(); // id -> AbortController

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== "string") return false;

  if (msg.type === "API_ABORT") {
    var c = inflight.get(msg.id);
    if (c) { try { c.abort(); } catch (e) {} }
    return false;
  }

  if (msg.type !== "API_FETCH") return false;

  var id = String(msg.id || "");
  var ctrl = new AbortController();
  inflight.set(id, ctrl);

  (async function () {
    try {
      var init = {
        method: msg.method || "GET",
        headers: msg.headers || {},
        signal: ctrl.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "follow"
      };
      if (msg.body != null && init.method !== "GET") init.body = msg.body;
      var res = await fetch(msg.url, init);
      var text = "";
      try { text = await res.text(); } catch (e) { text = ""; }
      sendResponse({
        ok: true, status: res.status, statusText: res.statusText,
        type: res.headers.get("content-type") || "", text: text
      });
    } catch (e) {
      var aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
      sendResponse({
        ok: false, status: 0, aborted: !!aborted,
        error: String((e && e.message) || e)
      });
    } finally {
      inflight.delete(id);
    }
  })();

  return true; // respons dikirim async
});

/* Form Solver - widget.js (UI dalam halaman Google Form)
 * - Tombol "AI Form Solver" disuntik di bawah judul form -> klik = isi otomatis.
 * - Riwayat jawaban: panel kanan-atas (buka/tutup), tersimpan lokal (maks 8).
 * - Pengaturan: panel kanan-bawah (provider, model, key, test, kuota, clear).
 * - Berjalan di content-script (isolated world): pakai window.AI + window.RazorEngine.
 * - Styling panel: Shadow DOM + widget.css (terisolasi dari CSS Google).
 */
(function () {
  "use strict";
  if (!window.RazorEngine || !window.RazorEngine.isGoogleForm()) return;
  if (document.getElementById("rz-host")) return; // cegah dobel inject

  var AI = window.AI, Engine = window.RazorEngine;
  var Z = 2147483000;

  var SVG = {
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>',
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.7-7 10-7 10 7 10 7-3.7 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3.2"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.2A10.9 10.9 0 0 1 12 5c6.3 0 10 7 10 7a18.2 18.2 0 0 1-3.3 4.2M6.5 6.6A17.9 17.9 0 0 0 2 12s3.7 7 10 7a10.6 10.6 0 0 0 4.1-.8"/><path d="M9.9 9.9a3.2 3.2 0 0 0 4.2 4.2"/></svg>'
  };

  // ---------- Motion ----------
  // Panel, baris riwayat, dan toast memakai animasi CSS (keyframes rz-in /
  // rz-row / rz-toast) yang otomatis NON-AKTIF saat user memilih
  // "reduce motion" di OS. Error diketaggeter ringan lewat .rz-shake.

  var KEY_URLS = {
    xkiro: "https://xkiro.com/dashboard/api/keys"
  };
  var STORE_KEYS = {
    xkiro: { key: "razor_xk_key", model: "razor_xk_model", custom: "razor_xk_custom", effort: "razor_xk_effort" }
  };

  var provider = "xkiro";
  var aborter = null, running = false, hidden = false;

  // ---------- storage ----------
  function storeGet(keys) {
    return new Promise(function (res) {
      try { chrome.storage.local.get(keys, function (d) { res(d || {}); }); }
      catch (e) { res({}); }
    });
  }
  function storeSet(o) {
    return new Promise(function (res) {
      try { chrome.storage.local.set(o, function () { res(); }); }
      catch (e) { res(); }
    });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return ""; }
  }

  // ---------- settings ----------
  function getKeys() {
    var seen = {}, out = [];
    keyEl.value.split(/\r?\n/).forEach(function (ln) {
      var k = ln.trim();
      if (k && !seen[k]) { seen[k] = 1; out.push(k); }
    });
    return out;
  }
  function getModel() {
    var c = modelCustomEl.value.trim();
    if (c) return c;
    // Jaring pengaman: nilai select bisa kosong (mis. opsi dihapus/di-override).
    // Ambil opsi pertama daripada mengirim model kosong ke API.
    if (modelSelectEl.value) return modelSelectEl.value.trim();
    try {
      if (modelSelectEl.options.length > 0) return modelSelectEl.options[0].value;
    } catch (e) {}
    return "";
  }
  function getEffort() {
    return effortEl ? effortEl.value : "";
  }
  // Isi dropdown effort sesuai model aktif: model non-reasoning hanya punya "Default".
  function syncEffortOptions(keep) {
    if (!effortEl) return;
    var levels = (AI.effortLevels ? AI.effortLevels(provider, getModel()) : [""]) || [""];
    var prev = (keep === undefined) ? effortEl.value : keep;
    effortEl.innerHTML = "";
    levels.forEach(function (v) {
      var o = document.createElement("option");
      o.value = v;
      o.textContent = AI.effortLabel ? AI.effortLabel(v) : (v || "Default");
      effortEl.appendChild(o);
    });
    var usable = levels.length > 1;
    effortEl.disabled = !usable;
    effortResetBtn.disabled = !usable;
    if (levels.indexOf(prev) >= 0) effortEl.value = prev;
    else effortEl.value = levels[0];
    if (effortHintEl) {
      var def = (AI.effortDefault ? AI.effortDefault(provider, getModel()) : "") || "";
      var defTxt = usable && def ? " (setelan model: " + AI.effortLabel(def) + ")" : "";
      effortHintEl.textContent = usable
        ? "Default = ikut setelan model" + defTxt + ". Naik untuk soal hitung/berantai, tapi lebih lambat."
        : "Model ini tidak memakai reasoning effort — hanya Default. Kalau keliru, klik Test dulu (daftar effort diambil dari katalog model).";
    }
  }
  async function saveSettings() {
    var k = STORE_KEYS[provider], o = { razor_provider: provider };
    if (k.key) o[k.key] = keyEl.value.trim();
    o[k.model] = modelSelectEl.value;
    o[k.custom] = modelCustomEl.value.trim();
    if (k.effort) o[k.effort] = getEffort();
    await storeSet(o);
  }
  function setDatalistOptions(select, models, keep) {
    select.innerHTML = "";
    (models || []).forEach(function (m) {
      var o = document.createElement("option");
      o.value = m; o.textContent = m;
      select.appendChild(o);
    });
    if (keep && Array.prototype.some.call(select.options, function (o) { return o.value === keep; })) {
      select.value = keep;
    } else if (select.options.length > 0 && !select.value) {
      select.selectedIndex = 0;
    }
  }
  function ensureModelOption(select, name) {
    name = String(name || "").trim();
    if (!name) return;
    var exists = Array.prototype.some.call(select.options, function (o) { return o.value === name; });
    if (!exists) {
      var o = document.createElement("option");
      o.value = name; o.textContent = name;
      select.appendChild(o);
    }
  }

  // ---------- toast ----------
  function toast(msg, ms) {
    var t = document.createElement("div");
    t.className = "rz-toast";
    t.textContent = msg;
    toastsEl.appendChild(t);
    setTimeout(function () {
      t.classList.add("out");
      setTimeout(function () { t.remove(); }, 160);
    }, ms || 3600);
  }

  // ---------- tombol utama (light DOM, inline style anti-bocor CSS Google) ----------
  var ctaBtn = null, ctaLabel = null, ctaState = null;
  function styleCta() {
    ctaBtn.style.cssText = "display:inline-flex;align-items:center;gap:10px;padding:12px 20px;margin:10px 0 6px;" +
      "border-radius:14px;border:1px solid #d6d9e0;cursor:pointer;" +
      "background:linear-gradient(135deg,#ffffff,#e2e5eb);color:#14161c;" +
      "font:700 14px 'Segoe UI',system-ui,sans-serif;box-shadow:0 6px 18px rgba(20,22,28,.12);" +
      "transition:transform .15s,filter .15s;";
    ctaBtn.onmouseenter = function () { ctaBtn.style.filter = "brightness(.97)"; };
    ctaBtn.onmouseleave = function () { ctaBtn.style.filter = ""; };
  }
  function setCta(mode, text) {
    // mode: idle | work | done | error — teks saja, tanpa ikon.
    ctaState = mode;
    ctaLabel.textContent = text;
    ctaBtn.disabled = false;
    ctaBtn.style.opacity = "";
    ctaBtn.innerHTML = "";
    if (mode === "work") {
      var sp = document.createElement("span");
      sp.className = "rzs";
      ctaBtn.appendChild(sp);
    }
    ctaBtn.appendChild(ctaLabel);
    if (mode === "error") {
      ctaBtn.classList.remove("rz-shake2");
      void ctaBtn.offsetWidth;
      ctaBtn.classList.add("rz-shake2");
    }
  }
  function injectCtaStyle() {
    if (document.getElementById("rz-cta-style")) return;
    var st = document.createElement("style");
    st.id = "rz-cta-style";
    st.textContent = "#rz-cta-btn .rzs{display:inline-block;width:15px;height:15px;border-radius:50%;" +
      "border:2px solid #d6d9e0;border-top-color:#14161c;animation:rz-spin2 .8s linear infinite}" +
      "#rz-cta-btn:focus-visible{outline:2px solid #14161c;outline-offset:2px}" +
      "#rz-cta-btn.rz-shake2{animation:rz-shake2 .32s ease-in-out}" +
      "@keyframes rz-spin2{to{transform:rotate(360deg)}}" +
      "@keyframes rz-shake2{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}" +
      "@media (prefers-reduced-motion:reduce){#rz-cta-btn .rzs,#rz-cta-btn.rz-shake2{animation:none}}";
    document.head.appendChild(st);
  }
  function titleAnchor() {
    var hs = document.querySelectorAll('[role="heading"]');
    for (var i = 0; i < hs.length; i++) {
      if (!hs[i].closest('div[role="listitem"]')) return hs[i];
    }
    return null;
  }
  function mountCta() {
    injectCtaStyle();
    var wrap = document.createElement("div");
    wrap.id = "rz-cta-wrap";
    ctaWrap = wrap;
    ctaBtn = document.createElement("button");
    ctaBtn.id = "rz-cta-btn";
    ctaBtn.type = "button";
    ctaBtn.setAttribute("aria-live", "polite");
    ctaLabel = document.createElement("span");
    wrap.appendChild(ctaBtn);
    styleCta();
    setCta("idle", "AI Form Solver");
    ctaBtn.title = "Isi form otomatis dengan AI (klik lagi untuk Batal saat berjalan)";
    ctaBtn.addEventListener("click", function () {
      if (running) { onStop(); } else { run(); }
    });
    var anchor = titleAnchor();
    if (anchor && anchor.parentElement) {
      anchor.after(wrap);
    } else {
      // Fallback: pil melayang bila judul tak ditemukan.
      wrap.style.cssText = "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:" + Z;
      document.body.appendChild(wrap);
    }
  }

  // ---------- gambar -> base64 ----------
  function fetchImageAsBase64(url, signal) {
    return new Promise(function (resolve) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 10000);
      function onAbort() { clearTimeout(timer); try { ctrl.abort(); } catch (e) {} }
      if (signal) {
        if (signal.aborted) { onAbort(); resolve(null); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      fetch(url, { signal: ctrl.signal }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.blob();
      }).then(function (blob) {
        var fr = new FileReader();
        fr.onload = function () {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          var m = String(fr.result || "").match(/^data:([^;]+);base64,(.*)$/);
          resolve(m ? { b64: m[2], mime: m[1] } : null);
        };
        fr.onerror = function () { clearTimeout(timer); resolve(null); };
        fr.readAsDataURL(blob);
      }).catch(function () { clearTimeout(timer); resolve(null); });
    });
  }

  // ---------- alur utama ----------
  function newAborter() {
    if (aborter) { try { aborter.abort("diganti"); } catch (e) {} }
    aborter = new AbortController();
    return aborter.signal;
  }
  function onStop() {
    if (aborter) { try { aborter.abort("Stop"); } catch (e) {} }
    running = false;
    setCta("idle", "AI Form Solver");
    setStatus("Dibatalkan.", false);
  }

  async function run() {
    if (running) return;
    var keys = getKeys();
    if (!keys.length) {
      openPanel("set");
      toast("Tempel API key dulu di Pengaturan.");
      return;
    }
    running = true;
    var signal = newAborter();
    setCta("work", "Menganalisis form… (klik untuk Batal)");
    setStatus("Scanning…", true);
    var visionNote = "", keyNoteSuffix = "";
    try {
      var found = await Engine.analyze();
      var qs = found.questions || [];
      if (!qs.length) throw new Error("Tidak ada pertanyaan.");
      var model = getModel() || AI.defaultModel(provider);
      if (qs.some(function (q) { return q.images && q.images.length > 0; }) &&
          !AI.isVisionModel(provider, model)) {
        model = AI.defaultVisionModel(provider);
        ensureModelOption(modelSelectEl, model);
        modelSelectEl.value = model;
        modelCustomEl.value = "";
        await saveSettings();
        visionNote = " · auto-vision " + model;
      }
      var urls = [], seen = {};
      qs.forEach(function (q) {
        (q.images || []).forEach(function (u) { if (!seen[u]) { seen[u] = 1; urls.push(u); } });
      });
      var imageData = new Map();
      if (urls.length > 0) {
        setCta("work", "Mengambil " + urls.length + " gambar…");
        var results = await Promise.all(urls.map(function (u) { return fetchImageAsBase64(u, signal); }));
        urls.forEach(function (u, i) { imageData.set(u, results[i]); });
      }
      var kn = keys.length;
      var keyNote = function () {
        return kn > 1 ? " [key " + (AI.lastKeyIndex(provider) + 1) + "/" + kn + "]" : "";
      };
      setStatus("Menjawab 0/" + qs.length + "…", true);
      var answers = await AI.solve(
        provider,
        { apiKey: keys[0], keys: keys, model: model, effort: getEffort() },
        qs, imageData, signal,
        function (done, total) {
          setCta("work", "Menjawab " + done + "/" + total + "…" + visionNote);
          setStatus("Menjawab " + done + "/" + total + "…" + visionNote + keyNote(), true);
        }
      );
      keyNoteSuffix = keyNote();
      // Model yang BENAR-BENAR menjawab, kalau gateway diam-diam melepas.
      var swapNote = AI.remoteModelNote ? AI.remoteModelNote() : "";
      if (swapNote) toast(swapNote);
      try {
        var curKey = keys[AI.lastKeyIndex(provider)] || keys[0];
        var gq = await AI.getQuota(provider, { apiKey: curKey }, signal);
        if (gq) setQuota(gq.state || "ok", gq.text || "Kuota terbaca");
      } catch (e) {}
      setCta("work", "Mengisi jawaban…");
      setStatus("Mengisi jawaban…", true);
      var fill = await Engine.fill(answers);
      await saveHistory({
        at: Date.now(), provider: provider, model: model,
        filled: fill.filled, total: fill.total, details: fill.details || []
      });
      await renderHistory();
      var msg = "Selesai " + fill.filled + "/" + fill.total + visionNote + keyNoteSuffix;
      if (fill.skipped && fill.skipped.length > 0) msg += " · lewati " + fill.skipped.length;
      if (swapNote) msg += " · " + swapNote;
      setCta(fill.filled === fill.total ? "done" : "error", msg);
      setStatus(msg + " — cek jawaban lalu Submit manual.", false);
      toast(fill.filled === fill.total ? "Semua terisi. Cek lalu Submit manual." : msg);
      setTimeout(function () { if (!running) setCta("idle", "AI Form Solver"); }, 6000);
    } catch (err) {
      var m = (err && err.message) || String(err);
      if (/Dibatalkan|abort/i.test(m)) {
        setCta("idle", "AI Form Solver");
        setStatus("Dibatalkan.", false);
      } else {
        if (AI.isLimitError(m)) setQuota("limited", "Kuota HABIS (429) · coba lagi nanti");
        setCta("error", "Gagal — lihat Pengaturan");
        setStatus("Error: " + m, false);
        if (statusEl.classList) { statusEl.classList.remove("rz-shake"); void statusEl.offsetWidth; statusEl.classList.add("rz-shake"); }
      }
    } finally {
      running = false;
    }
  }

  // ---------- history ----------
  async function loadHistory() {
    var d = await storeGet(["razor_history"]);
    return Array.isArray(d.razor_history) ? d.razor_history : [];
  }
  async function saveHistory(run) {
    var h = await loadHistory();
    h.unshift(run);
    await storeSet({ razor_history: h.slice(0, 8) });
  }
  async function clearHistory() {
    await storeSet({ razor_history: [] });
    await renderHistory();
  }
  async function renderHistory() {
    var h = await loadHistory();
    histCountEl.textContent = h.length > 0 ? String(h.length) : "";
    histCountEl.style.display = h.length > 0 ? "grid" : "none";
    if (!h.length) {
      histListEl.innerHTML = '<div class="rz-empty">Belum ada riwayat.<br>Klik AI Form Solver untuk mulai.</div>';
      return;
    }
    histListEl.innerHTML = h.map(function (r, i) {
      var pct = r.total > 0 ? Math.round(r.filled / r.total * 100) : 0;
      var rows = (r.details || []).map(function (d) {
        var a = d.picked ? "<span>→ " + esc(Array.isArray(d.picked) ? d.picked.join(", ") : d.picked) + "</span>" : "";
        var rr = (d.reason && !d.ok) ? "<em>" + esc(d.reason) + "</em>" : "";
        return '<div class="rz-hrow"><span class="' + (d.ok ? "rz-hok" : "rz-hbad") + '">' + (d.ok ? "✓" : "✗") +
          '</span><div class="rz-hq"><b>' + esc(d.question) + "</b>" + a + rr + "</div></div>";
      }).join("");
      return '<div class="rz-run" style="--i:' + i + '">' +
        '<div class="rz-run-top"><time>' + esc(fmtTime(r.at)) + "</time>" +
        '<span class="rz-score">' + r.filled + "/" + r.total + "</span></div>" +
        '<div class="rz-model">' + esc(r.provider) + " · " + esc(r.model) + "</div>" +
        '<div class="rz-bar"><i style="width:' + pct + '%"></i></div>' +
        "<details><summary>Riwayat jawaban</summary>" + rows + "</details></div>";
    }).join("");
  }

  // ---------- settings: test/kuota ----------
  function setQuota(state, text) {
    quotaEl.className = "rz-quota " + state;
    quotaTextEl.textContent = text;
    var o = {};
    o["razor_quota_" + provider] = { state: state, text: text, at: Date.now() };
    storeSet(o);
  }
  function setStatus(text, working) {
    statusEl.innerHTML = (working ? '<span class="rz-spin"></span>' : "") + esc(text);
  }
  async function onTest() {
    var signal = newAborter();
    setBusySettings(true);
    setStatus("Memeriksa " + AI.PROVIDERS[provider].label + "…", true);
    try {
      var keys = getKeys();
      if (!keys.length) throw new Error("API key kosong. Isi 1 key atau lebih.");
      var prev = getModel();
      await saveSettings();
      var r = await AI.testConnection(provider, { apiKey: keys[0], keys: keys, model: prev, effort: getEffort() }, signal);
      var models = (r.models && r.models.length > 0) ? r.models : AI.suggestModels(provider);
      // Model tersimpan bisa sudah DIHAPUS provider -> jangan dibiarkan,
      // otomatis pindah ke model live terbaik dari katalog.
      var dead = prev && AI.modelExists && !AI.modelExists(provider, prev);
      var alt = (r.best || (AI.bestModel ? AI.bestModel(provider) : "")) || "";
      var chosen = prev;
      if (dead && alt) { chosen = alt; modelCustomEl.value = ""; toast("Model \"" + prev + "\" sudah dihapus — pindah ke \"" + alt + "\"."); }
      setDatalistOptions(modelSelectEl, models, chosen);
      if (chosen) {
        ensureModelOption(modelSelectEl, chosen);
        modelSelectEl.value = chosen;
        if (!dead) modelCustomEl.value = "";
      }
      syncEffortOptions(); // capabilities model baru -> daftar effort ikut berubah
      await saveSettings();
      if (r.xquota) setQuota(r.xquota.state || "ok", r.xquota.text || "Kuota terbaca");
      var ki = (r.keysTotal && r.keysTotal > 1) ? " · " + r.keysOk + "/" + r.keysTotal + " key OK" : "";
      var warn = dead ? " · model lama sudah dihapus XKiro, diganti otomatis" : "";
      setStatus(AI.PROVIDERS[provider].label + " Connected — " + models.length + " model." + ki + warn, false);
      toast("Terhubung: " + AI.PROVIDERS[provider].label);
    } catch (err) {
      var m = (err && err.message) || String(err);
      if (AI.isLimitError(m)) setQuota("limited", "Kuota HABIS (429) · coba lagi nanti");
      setStatus("Gagal: " + m, false);
    } finally {
      setBusySettings(false);
    }
  }
  function setBusySettings(b) {
    [testBtn, refreshBtn].forEach(function (x) { if (x) x.disabled = b; });
  }

  // ---------- panel open/close ----------
  function openPanel(which) {
    if (which === "hist") {
      histPanel.style.display = "flex";
      setPanel.style.display = "none";
      renderHistory();
    } else {
      setPanel.style.display = "block";
      histPanel.style.display = "none";
    }
  }
  function closePanels() {
    histPanel.style.display = "none";
    setPanel.style.display = "none";
    setKeyVisible(false);
  }

  // API key default-nya DISEMBUNYIKAN (aman saat diklik orang lain / screenshot).
  var keyHideTimer = null;
  function setKeyVisible(v) {
    if (!keyEl || !keyEyeBtn) return;
    keyEl.classList.toggle("masked", !v);
    keyEyeBtn.setAttribute("aria-pressed", v ? "true" : "false");
    keyEyeBtn.setAttribute("aria-label", v ? "Sembunyikan API key" : "Tampilkan API key");
    keyEyeBtn.innerHTML = v ? SVG.eyeOff : SVG.eye;
    if (keyHideTimer) { clearTimeout(keyHideTimer); keyHideTimer = null; }
    if (v) keyHideTimer = setTimeout(function () { setKeyVisible(false); }, 30000);
  }
  function toggleRoot() {
    hidden = !hidden;
    hostEl.style.display = hidden ? "none" : "";
    if (ctaWrap) ctaWrap.style.display = hidden ? "none" : "";
    storeSet({ razor_widget_hidden: hidden });
  }

  // ---------- shadow refs (diisi saat boot) ----------
  var hostEl = null, sh = null, ctaWrap = null;
  var histChip, histCountEl, histPanel, histListEl, histClearBtn;
  var setFab, setPanel, keyEl, keyHintEl, getKeyBtn, keyEyeBtn;
  var modelSelectEl, modelCustomEl, refreshBtn, testBtn, quotaEl, quotaTextEl, statusEl;
  var effortEl, effortHintEl, effortResetBtn;
  var clearBtn, hideBtn, toastsEl;

  function q(sel) { return sh.querySelector(sel); }

  function buildShadow(css) {
    hostEl = document.createElement("div");
    hostEl.id = "rz-host";
    document.documentElement.appendChild(hostEl);
    sh = hostEl.attachShadow({ mode: "open" });
    sh.innerHTML =
      "<style>" + css + "</style>" +
      '<div class="rz-root">' +
      '<button class="rz-fab rz-fab-hist" id="rz-hist-chip" aria-label="Buka riwayat jawaban">' + SVG.clock +
      '<span>Riwayat</span><span class="rz-count" id="rz-hist-count" style="display:none"></span></button>' +
      '<section class="rz-panel rz-panel-hist" id="rz-hist-panel" style="display:none" aria-label="Riwayat jawaban">' +
      '<div class="rz-head"><div class="rz-mark">F</div><div><h2>RIWAYAT</h2><p>JAWABAN AI</p></div>' +
      '<button class="rz-x" id="rz-hist-x" aria-label="Tutup riwayat">' + SVG.x + "</button></div>" +
      '<div class="rz-body"><div id="rz-hist-list"></div>' +
      '<button class="rz-keybtn" id="rz-hist-clear">Hapus riwayat</button></div></section>' +
      '<button class="rz-fab rz-fab-set" id="rz-set-fab" aria-label="Buka pengaturan">' + SVG.gear + "<span>Pengaturan</span></button>" +
      '<section class="rz-panel rz-panel-set" id="rz-set-panel" style="display:none" aria-label="Pengaturan AI">' +
      '<div class="rz-head"><div class="rz-mark">F</div><div><h2>FORM SOLVER</h2><p>PENGATURAN AI</p></div>' +
      '<button class="rz-x" id="rz-set-x" aria-label="Tutup pengaturan">' + SVG.x + "</button></div>" +
      '<div class="rz-body">' +
      '<div class="rz-field"><label for="rz-key">API Key (multi)</label>' +
      '<div class="rz-krow">' +
      '<textarea class="rz-area masked" id="rz-key" rows="3" spellcheck="false" autocomplete="off" placeholder="1 key per baris — otomatis pindah bila limit"></textarea>' +
      '<button type="button" class="rz-eye" id="rz-key-eye" aria-pressed="false" aria-label="Tampilkan API key" title="Tampilkan / sembunyikan API key">' + SVG.eye + "</button></div>" +
      '<p class="rz-hint" id="rz-keyhint"></p></div>' +
      '<div class="rz-field"><label for="rz-model">Model</label>' +
      '<div class="rz-mrow"><select class="rz-select" id="rz-model"></select>' +
      '<button class="rz-mini" id="rz-refresh" title="Muat ulang daftar model">↻</button></div>' +
      '<input class="rz-input" id="rz-custom" style="margin-top:8px" spellcheck="false" autocomplete="off" placeholder="Custom model (opsional)" />' +
      '<p class="rz-hint">Hasil Test muncul di dropdown. Soal bergambar otomatis pakai model vision.</p></div>' +
      '<div class="rz-field"><label for="rz-effort">Reasoning effort</label>' +
      '<div class="rz-mrow"><select class="rz-select" id="rz-effort"></select>' +
      '<button class="rz-mini" id="rz-effort-reset" title="Kembali ke Default">↺</button></div>' +
      '<p class="rz-hint" id="rz-efforthint">Default = ikut setelan model. Naik untuk soal hitung/berantai, tapi lebih lambat.</p></div>' +
      '<div class="rz-field"><button type="button" class="rz-keybtn" id="rz-getkey">Dapatkan API Key XKiro ↗</button></div>' +
      '<div class="rz-btns">' +
      '<button class="rz-btn go" id="rz-test">Test XKiro</button>' +
      '<button class="rz-btn dim" id="rz-clear">Clear form (reload)</button>' +
      '<button class="rz-btn ghost" id="rz-stop">Stop</button>' +
      '<button class="rz-btn ghost" id="rz-hide">Sembunyikan widget</button>' +
      "</div>" +
      '<div class="rz-quota unknown" id="rz-quota"><i></i><span id="rz-quota-text">Kuota: belum dicek</span></div>' +
      '<p class="rz-status" id="rz-status" aria-live="polite">Ready</p>' +
      "</div></section>" +
      '<div class="rz-toasts" id="rz-toasts" aria-live="polite"></div>' +
      "</div>";
    histChip = q("#rz-hist-chip"); histCountEl = q("#rz-hist-count");
    histPanel = q("#rz-hist-panel"); histListEl = q("#rz-hist-list"); histClearBtn = q("#rz-hist-clear");
    setFab = q("#rz-set-fab"); setPanel = q("#rz-set-panel");
    keyEl = q("#rz-key"); keyHintEl = q("#rz-keyhint"); getKeyBtn = q("#rz-getkey"); keyEyeBtn = q("#rz-key-eye");
    modelSelectEl = q("#rz-model"); modelCustomEl = q("#rz-custom"); refreshBtn = q("#rz-refresh");
    effortEl = q("#rz-effort"); effortHintEl = q("#rz-efforthint"); effortResetBtn = q("#rz-effort-reset");
    testBtn = q("#rz-test"); quotaEl = q("#rz-quota"); quotaTextEl = q("#rz-quota-text");
    statusEl = q("#rz-status"); clearBtn = q("#rz-clear"); hideBtn = q("#rz-hide");
    toastsEl = q("#rz-toasts");
  }

  function renderProvider() {
    var cfg = AI.PROVIDERS[provider];
    keyHintEl.textContent = "Key XKiro (dashboard → API Keys). 1 per baris.";
    getKeyBtn.textContent = "Dapatkan API Key " + cfg.label + " ↗";
    testBtn.textContent = "Test " + cfg.label;
  }

  function applyStore(d) {
    var k = STORE_KEYS[provider];
    keyEl.value = (k.key && d[k.key]) || "";
    setDatalistOptions(modelSelectEl, AI.suggestModels(provider));
    // WAJIB ensureModelOption DULUAN: assign nilai yang tidak ada di <select>
    // akan mengosongkan value -> tersimpan "" -> request tanpa model -> 400.
    // Default dari katalog (mis. google/gemma-4-26b-a4b-it:free) memang tidak
    // ada di daftar suggest.
    var want = (k.model && d[k.model]) || AI.defaultModel(provider) || "";
    ensureModelOption(modelSelectEl, want);
    if (want) modelSelectEl.value = want;
    if (!modelSelectEl.value && modelSelectEl.options.length > 0) modelSelectEl.selectedIndex = 0;
    modelCustomEl.value = (k.custom && d[k.custom]) || "";
    syncEffortOptions((k.effort && d[k.effort]) || "");
    var qk = d["razor_quota_" + provider];
    if (qk && qk.state) { quotaEl.className = "rz-quota " + qk.state; quotaTextEl.textContent = qk.text; }
    else { quotaEl.className = "rz-quota unknown"; quotaTextEl.textContent = "Kuota: belum dicek — klik Test"; }
  }

  function wire() {
    histChip.addEventListener("click", function () {
      var open = histPanel.style.display !== "none";
      if (open) histPanel.style.display = "none";
      else openPanel("hist");
    });
    q("#rz-hist-x").addEventListener("click", function () { histPanel.style.display = "none"; });
    histClearBtn.addEventListener("click", function () { clearHistory(); toast("Riwayat dihapus."); });
    setFab.addEventListener("click", function () {
      var open = setPanel.style.display !== "none";
      if (open) { setPanel.style.display = "none"; setKeyVisible(false); }
      else openPanel("set");
    });
    q("#rz-set-x").addEventListener("click", function () { setPanel.style.display = "none"; setKeyVisible(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closePanels();
    });
    getKeyBtn.addEventListener("click", function () {
      var url = KEY_URLS[provider] || KEY_URLS.xkiro;
      try { window.open(url, "_blank"); } catch (e) {}
    });
    keyEyeBtn.addEventListener("mousedown", function (e) { e.preventDefault(); });
    keyEyeBtn.addEventListener("click", function () {
      setKeyVisible(keyEl.classList.contains("masked"));
    });
    keyEl.addEventListener("blur", function () {
      if (!keyEl.classList.contains("masked")) setKeyVisible(false);
    });
    testBtn.addEventListener("click", onTest);
    refreshBtn.addEventListener("click", onTest);
    modelSelectEl.addEventListener("change", function () {
      modelCustomEl.value = "";
      syncEffortOptions();
      saveSettings();
    });
    modelCustomEl.addEventListener("change", function () { syncEffortOptions(); saveSettings(); });
    effortEl.addEventListener("change", saveSettings);
    effortResetBtn.addEventListener("click", function () {
      if (!effortEl || effortEl.disabled) return;
      effortEl.value = "";
      saveSettings();
      toast("Effort dikembalikan ke Default.");
    });
    keyEl.addEventListener("change", saveSettings);
    q("#rz-stop").addEventListener("click", function () {
      if (aborter) { try { aborter.abort("Stop"); } catch (e) {} }
      running = false;
      setCta("idle", "AI Form Solver");
      setStatus("Dibatalkan.", false);
    });
    clearBtn.addEventListener("click", function () {
      if (running) { toast("Hentikan dulu proses yang berjalan."); return; }
      location.reload(); // radio/dropdown tak bisa di-uncheck manual — reload = bersih total
    });
    hideBtn.addEventListener("click", toggleRoot);
  }

  async function boot() {
    var css = "";
    try {
      var res = await fetch(chrome.runtime.getURL("widget.css"));
      if (res.ok) css = await res.text();
    } catch (e) {}
    buildShadow(css);
    wire();
    var d = await storeGet(null);
    hidden = !!(d && d.razor_widget_hidden);
    provider = (d && d.razor_provider && AI.PROVIDERS[d.razor_provider]) ? d.razor_provider : "xkiro";
    renderProvider();
    applyStore(d || {});
    mountCta();
    await renderHistory();
    if (hidden) {
      hostEl.style.display = "none";
      if (ctaWrap) ctaWrap.style.display = "none";
    }
    setStatus("Ready.", false);
  }

  // Toggle dari icon toolbar (sw.js) — tanpa reload halaman.
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.action === "TOGGLE_WIDGET") {
        if (!hostEl) { sendResponse({ ok: false }); return true; }
        toggleRoot();
        sendResponse({ ok: true, hidden: hidden });
      }
      return true;
    });
  } catch (e) {}

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

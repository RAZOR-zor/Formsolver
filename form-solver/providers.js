/* Form Solver - providers.js
 * Klien AI: XKiro (https://api.xkiro.com/v1, OpenAI-compatible).
 * - Key TIDAK di-hardcode — dari widget + chrome.storage.local.
 * - Cepat: soal dipecah jadi batch kecil (6 soal) + request paralel.
 * - Isian singkat: prompt memaksa jawaban pendek (hitungan = angka saja).
 * - Gambar: dikirim sebagai data (vision) bila soal bergambar.
 * - Model &(fitur) diambil dari katalog live /v1/models, bukan nama model karangan.
 * Global: window.AI
 */
(function () {
  "use strict";

  var PROVIDERS = {
    xkiro: {
      label: "XKiro", needsKey: true,
      // JANGAN hardcode model id: model bisa dihapus XKiro kapan saja (404).
      // Default diambil dari katalog live (lihat bestModel).
      defaultModel: "",
      defaultVision: "",
      // Fallback kalau katalog belum termuat. Daftar penuh diisi saat Test.
      suggest: [
        "mistralai/ministral-8b",
        "mistralai/ministral-14b",
        "cohere/command-a-vision",
        "qwen/qwen3.5-omni-flash:free",
        "mistralai/mistral-large-2512",
        "google/gemini-2.5-flash"
      ],
      batchSize: 6, concurrency: 4
    }
  };

  var XK_BASE = "https://api.xkiro.com/v1";

  function trimSlash(u) { return String(u || "").trim().replace(/\/+$/, ""); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function withTimeout(signal, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(new Error("Timeout")); }, ms);
    function onAbort() {
      clearTimeout(timer);
      try { ctrl.abort(signal && signal.reason ? signal.reason : new Error("Dibatalkan")); }
      catch (e) { ctrl.abort(); }
    }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: ctrl.signal,
      done: function () { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); }
    };
  }

  function chunk(arr, n) {
    var out = [];
    for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  // ================= TRANSPORT (bypass CORS lewat service worker) =================
  // Content script hidup di origin docs.google.com -> fetch cross-origin tunduk CORS.
  // api.xkiro.com: OPTIONS preflight 404 + tanpa Access-Control-Allow-Origin
  //   -> browser blokir -> "TypeError: Failed to fetch".
  // Solusi: coba langsung; bila gagal di layer jaringan/CORS, ulangi via service
  // worker (origin extension + host_permissions = CORS dilewati).
  var swSeq = 0;

  function resShim(status, statusText, text) {
    return {
      ok: status >= 200 && status < 300,
      status: status,
      statusText: statusText || "",
      text: function () { return Promise.resolve(text); },
      json: function () { return Promise.resolve(JSON.parse(text)); }
    };
  }

  function viaServiceWorker(url, init, signal) {
    return new Promise(function (resolve, reject) {
      var id = "rz" + (++swSeq) + "-" + Date.now().toString(36);
      var settled = false;
      function onAbort() {
        if (settled) return;
        try { chrome.runtime.sendMessage({ type: "API_ABORT", id: id }); } catch (e) {}
      }
      function cleanup() { if (signal) signal.removeEventListener("abort", onAbort); }
      var payload = {
        type: "API_FETCH", id: id, url: String(url),
        method: (init && init.method) || "GET",
        headers: (init && init.headers) || {},
        body: init && init.body != null ? init.body : null
      };
      try {
        chrome.runtime.sendMessage(payload, function (r) {
          settled = true;
          cleanup();
          var le = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) || null;
          if (le) { reject(new Error("SW: " + le.message)); return; }
          if (!r) { reject(new Error("SW: tidak ada respons")); return; }
          if (r.ok === false) {
            if (r.aborted) {
              var ae = new Error("Dibatalkan (Stop).");
              ae.name = "AbortError";
              reject(ae);
              return;
            }
            reject(new Error("SW: " + (r.error || "network error")));
            return;
          }
          resolve(resShim(r.status, r.statusText, r.text || ""));
        });
      } catch (e) {
        settled = true;
        cleanup();
        reject(new Error("SW tidak tersedia: " + ((e && e.message) || e)));
      }
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async function apiFetch(url, init) {
    var signal = init && init.signal;
    try {
      return await fetch(url, init);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      try {
        return await viaServiceWorker(url, init, signal);
      } catch (e2) {
        if (e2 && e2.name === "AbortError") throw e2;
        throw e; // pesan asli (TypeError: Failed to fetch) lebih informatif
      }
    }
  }

  // Pool paralel sederhana dengan batas concurrency.
  async function mapPool(items, limit, fn, signal) {
    var results = new Array(items.length);
    var i = 0;
    async function worker() {
      while (true) {
        if (signal && signal.aborted) throw new Error("Dibatalkan (Stop).");
        var idx = i++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx], idx);
      }
    }
    var workers = [];
    var n = Math.min(limit, items.length);
    for (var k = 0; k < n; k++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  // ---------- Prompt ----------
  function promptQuestion(q) {
    var o = { question: q.question, type: q.type, options: q.options || [] };
    // Dropdown yang opsi-nya gagal terbaca: jangan paksa model menebak label
    // (dulu berakhir dijawab "Pilih"). Minta nilai plaintext — dicocokkan
    // fuzzy ke opsi asli saat fill.
    if (q.type === "dropdown" && (!o.options || o.options.length === 0)) {
      o.type = "short_answer";
      o.note = "dropdown, daftar opsi tidak terbaca - jawab NILAI yang paling tepat (nama/angka), bukan label menu";
    }
    if (q.images && q.images.length > 0) o.hasImage = true;
    if (q.unresolvedImages && q.unresolvedImages.length > 0) o.imageUrl = q.unresolvedImages;
    return o;
  }

  function buildPrompt(questions) {
    var lines = [];
    lines.push("You are a fast form-solving assistant for practice Google Forms owned by the user.");
    lines.push("Rules (STRICT - extra words = wrong):");
    lines.push("- JSON ONLY. No markdown. No explanation. No preamble.");
    lines.push("- \"answer\" must be the SHORTEST correct form, copied EXACTLY from options:");
    lines.push("  - choice/dropdown/true-false: ONE option text only. NEVER a letter.");
    lines.push("  - checkbox: array of option texts only.");
    lines.push("  - short_answer: 1-5 words. Math: NUMBER ONLY.");
    lines.push("  - paragraph: 1 sentence.");
    lines.push("- WRONG: {\"answer\": \"B\"}  |  RIGHT: {\"answer\": \"Jakarta\"}");
    lines.push("- WRONG: {\"answer\": \"Menurut saya jawabannya Jakarta karena ibukota\"}  |  RIGHT: {\"answer\": \"Jakarta\"}");
    lines.push("- WRONG: {\"answer\": \"Hasilnya adalah 12\"}  |  RIGHT: {\"answer\": \"12\"}");
    lines.push("- Questions with hasImage:true have their images attached separately; look at them.");
    lines.push("");
    lines.push("Input questions (JSON):");
    lines.push(JSON.stringify(questions.map(promptQuestion), null, 1));
    lines.push("");
    lines.push("Output format (JSON only): {\"answers\":[{\"question\":\"...\",\"answer\":\"...\"}]}");
    return lines.join("\n");
  }

  // ---------- Parser aman ----------
  function stripFence(s) {
    return String(s || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  }

  function parseAnswers(rawText) {
    // Buang blok reasoning <think> (Qwen3) bila lolos — hanya JSON yang diparse.
    var noThink = String(rawText || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    var out = stripFence(noThink.length > 0 ? noThink : rawText);
    var a = out.indexOf("{"), b = out.lastIndexOf("}");
    if (a !== -1 && b > a) out = out.slice(a, b + 1);
    var parsed;
    try { parsed = JSON.parse(out); }
    catch (e) {
      throw new Error("Response AI invalid (bukan JSON). Tidak mengisi form. Mentah: " +
        String(rawText).slice(0, 200));
    }
    var list = (parsed && Array.isArray(parsed.answers)) ? parsed.answers : (Array.isArray(parsed) ? parsed : null);
    if (!list) throw new Error("Response AI invalid: field \"answers\" hilang.");
    return list.map(function (it, i) {
      if (it == null) return { question: "", answer: "" };
      if (typeof it === "string") return { question: "", answer: it };
      return {
        question: String(it.question == null ? it.q == null ? "" : it.q : it.question),
        answer: it.answer != null ? it.answer : (it.a != null ? it.a : "")
      };
    });
  }

  // ---------- Deteksi error limit/kuota (untuk badge kuota) ----------
  function isLimitError(msg) {
    return /\b402\b|429|rate.?limit|quota|credit|resource.?exhausted|insufficient|billing|payment required|top-up/i.test(String(msg || ""));
  }

  // ================= REASONING EFFORT =================
  // Default (biarkan model pakai setelan sendiri) -> low -> max, mengikuti level
  // yang DIUMUMKAN model. XKiro memberi daftar level + default per model lewat
  // katalog (reasoning_efforts), jadi itu yang dipakai.
  var EFFORT_VALUES = ["", "minimal", "low", "medium", "high", "xhigh", "max",
                       "adaptive", "on", "off", "none", "disabled"];
  var DEFAULT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
  var EFFORT_LABELS = {
    "": "Default", minimal: "Minimal", low: "Low", medium: "Medium", high: "High",
    xhigh: "Xhigh", max: "Max", adaptive: "Adaptive", on: "On", off: "Off",
    none: "None", disabled: "Disabled"
  };

  function normEffort(v) {
    var s = String(v == null ? "" : v).trim().toLowerCase();
    return EFFORT_VALUES.indexOf(s) >= 0 ? s : "";
  }

  function applyEffort(body, effort) {
    var e = normEffort(effort);
    if (!e) return false;
    body.reasoning_effort = e;
    return true;
  }

  // Model ini support reasoning effort? Sumber kebenaran = metadata katalog XKiro
  // (capabilities.reasoning + reasoning_efforts.levels), bukan tebakan nama.
  function modelIsReasoning(provider, model) {
    var m = String(model || "");
    if (!m) return false;
    return effortLevels(provider, m).length > 1;
  }

  // Model ini bisa menerima gambar? (XKiro: capabilities.vision)
  function modelIsVision(provider, model) {
    var m = String(model || "");
    if (xkCaps && (m in xkCaps)) return !!xkCaps[m].vision;
    return false;
  }

  // Level yang boleh dipakai model ini (UI mengisi dropdown dari sini).
  // Selalu diawali "" (Default).
  function effortLevels(provider, model) {
    var m = String(model || "");
    if (!m) return [""];
    if (xkCaps && (m in xkCaps)) {
      var lv = xkCaps[m].efforts || [];
      if (lv.length > 0) return [""].concat(lv);
      return [""]; // katalog: model ini tidak punya effort yang bisa diatur
    }
    // Katalog belum dimuat (belum klik Test) -> heuristik nama model.
    return /gpt-5|gpt-6|^o[134](-|$)|deepseek-r|qwq|thinking|reasoner|reasoning|kimi|glm-4\.6|step-3|nova-pro/i.test(m)
      ? [""].concat(DEFAULT_EFFORT_LEVELS) : [""];
  }

  // Setelan effort default menurut model (XKiro mengumumkannya di katalog).
  function effortDefault(provider, model) {
    var m = String(model || "");
    if (xkCaps && (m in xkCaps) && xkCaps[m].effortDefault) {
      return normEffort(xkCaps[m].effortDefault) || "";
    }
    return "";
  }

  function effortLabel(v) {
    var e = normEffort(v);
    return EFFORT_LABELS[e] || (e ? e.charAt(0).toUpperCase() + e.slice(1) : "Default");
  }

  // ================= XKIRO (https://api.xkiro.com/v1, OpenAI-compatible) =================
  // Katalog publik + capabilities asli (vision/reasoning/efforts) di-cache saat Test.
  var xkCaps = {}; // id -> {vision, tools, reasoning, efforts, effortDefault, tier, priceIn, modality}

  // Kuota XKiro dari GET /v1/usage (gratis dipanggil): dompet + token gratis + window.
  // Return {state, text} siap badge. Dipakai Test DAN refresh otomatis setelah Fill.
  async function xkUsage(apiKey, signal) {
    var key = String(apiKey || "").trim();
    if (!key) throw new Error("API key XKiro kosong.");
    var t = withTimeout(signal, 15000);
    try {
      var res = await apiFetch(XK_BASE + "/usage", {
        headers: { "Authorization": "Bearer " + key }, signal: t.signal
      });
      if (res.status === 401 || res.status === 403) throw new Error("API key XKiro invalid.");
      if (res.status === 429) throw new Error("Rate limit XKiro (429).");
      if (!res.ok) throw new Error("XKiro HTTP " + res.status + ".");
      var d = await res.json();
      var parts = [], walletBal = null, freeRem = null;
      try {
        if (d.wallet && d.wallet.balance_usd != null) {
          walletBal = parseFloat(d.wallet.balance_usd);
          if (!isNaN(walletBal)) parts.push("Dompet $" + walletBal.toFixed(2));
        }
        if (d.free_tokens && d.free_tokens.remaining != null) {
          freeRem = Number(d.free_tokens.remaining);
          if (!isNaN(freeRem)) parts.push("gratis " + freeRem.toLocaleString("en-US").replace(/,/g, ".") + " tok");
        }
        (d.windows || []).forEach(function (w) {
          if (w && w.remaining_usd != null && Number(w.remaining_usd) < 1) {
            parts.push("window sisa $" + Number(w.remaining_usd).toFixed(2));
          }
        });
      } catch (e) {}
      var limited = (walletBal !== null && walletBal <= 0 && (freeRem === null || freeRem <= 0));
      return {
        state: limited ? "limited" : "ok",
        text: limited ? "Kuota HABIS" : ("Kuota aman" + (parts.length ? " · " + parts.join(" · ") : ""))
      };
    } finally { t.done(); }
  }

  // Kuota XKiro (satu-satunya provider).
  async function getQuota(provider, settings, signal) {
    var keys = (settings.keys && settings.keys.length) ? settings.keys : asKeys(settings.apiKey);
    var k = keys[(lastKeyIdx[provider] || 0) % (keys.length || 1)] || "";
    return xkUsage(k, signal);
  }

  // ================= PILIHAN MODEL (dari katalog live) =================
  // Model yang di-hardcode bisa dihapus XKiro kapan saja (404). Jadi semua
  // default & validasi membaca katalog /v1/models, bukan nama model karangan.
  function capsOf() { return xkCaps; }

  // Katalog bisa memuat model non-chat (gambar/musik/video/embedding) yang
  // tidak bisa dipakai /chat/completions.
  var NON_CHAT = /lyria|tts|whisper|dall-?e|flux|stable-?diffusion|sdxl|\bsora\b|\bveo\b|kling|hailuo|minimax-video|suno|elevenlabs|cartesion|moderation|guard-|embedding|rerank|nitro|\bexa\b|sonar|audio-?speech|voice-?clone|deepseek-r1-distill|\bclip\b/i;

  // Penalti besar supaya model non-chat tidak pernah jadi default/atas daftar.
  function chatPenalty(id, meta) {
    var s = String(id || "").toLowerCase();
    if (meta && meta.modality && meta.modality !== "chat") return 100;
    if (NON_CHAT.test(s)) return 100;
    return 0;
  }

  // Skor: gratis, kecil/cepat, bukan reasoning, bukan preview.
  function scoreModel(id, meta) {
    var s = String(id || "").toLowerCase();
    var m = meta || {};
    var v = chatPenalty(id, m);
    var free = /:free$/.test(s) || m.tier === "free" || m.priceIn === 0;
    if (free) v -= 5;
    if (/flash|mini|small|haiku|lite|nano|3b|8b|4b/.test(s)) v -= 3;
    if (/reason|thinking|r1\b|qwq|opus|sonnet|large/.test(s)) v += 5;
    if (/preview|experimental|beta\b/.test(s)) v += 3;
    return v;
  }

  // Comparator: skor dulu, lalu nama (agar urutan dropdown stabil).
  function cmpModel() {
    var cap = capsOf();
    return function (a, b) {
      var d = scoreModel(a, cap[a]) - scoreModel(b, cap[b]);
      return d !== 0 ? d : String(a).localeCompare(String(b));
    };
  }

  function catalogIds() { return Object.keys(xkCaps || {}); }
  function catalogLoaded() { return catalogIds().length > 0; }

  // Model paling aman & cepat menurut katalog saat ini.
  function bestModel() {
    var ids = catalogIds();
    if (ids.length === 0) return "";
    ids.sort(cmpModel());
    return ids[0];
  }

  // Apakah model masih ada di katalog? (katalog belum dimuat -> tidak dihakimi)
  function modelExists(model) {
    if (!catalogLoaded()) return true;
    return !!xkCaps[String(model || "")];
  }

  function AI_LABEL(provider) { return (PROVIDERS[provider] && PROVIDERS[provider].label) || "XKiro"; }

  // Model tidak ada (404). Kalau katalog sudah dimuat, tunjukkan alternatif
  // yang konkret — jangan asal bilang "tidak ada" lalu form dibiarkan kosong.
  function missingModelMsg(model) {
    if (!catalogLoaded()) {
      return "Model \"" + model + "\" ditolak XKiro (404). Klik Test untuk memuat katalog model terbaru.";
    }
    var best = bestModel();
    return "Model \"" + model + "\" sudah tidak ada di XKiro. Ganti ke: " +
      (best ? best : "(klik Test untuk memuat katalog)") + " — atau klik Test untuk daftar model terbaru.";
  }

  // 429 bukan berarti key rusak. Untuk model gratis, batasnya per key/IP
  // tergantung provider; tampilkan reasons dari server supaya jelas.
  function isFreeModel(model) {
    var id = String(model || "").toLowerCase();
    if (/:free$/.test(id)) return true;
    var m = xkCaps[String(model || "")];
    if (m && (m.priceIn === 0 || m.tier === "free")) return true;
    return false;
  }

  function rateLimitMsg(model, tx) {
    var reasons = "";
    try {
      var d = JSON.parse(String(tx || "").slice(0, 2000));
      var r = d && d.error && d.error.metadata && d.error.metadata.reasons;
      if (Array.isArray(r) && r.length) reasons = r.join(", ");
    } catch (e) {}
    var hint = reasons ? " (" + reasons + ")" : "";
    if (isFreeModel(model)) {
      return "XKiro 429 — rate limit model gratis" + hint +
        ". Tunggu ~1 menit, kurangi jumlah soal per jalan, atau pakai model non-free.";
    }
    return "XKiro 429 — rate limit / kuota habis" + hint + ". Tunggu sebentar atau top-up.";
  }

  // Test SEMUA key via /v1/usage + katalog publik 1x -> tahu "2/3 key OK".
  async function xkTest(keys, signal) {
    keys = asKeys(keys);
    if (!keys.length) throw new Error("API key XKiro kosong. Isi 1 key atau lebih (1 per baris).");
    var t = withTimeout(signal, 15000);
    var catalog = [];
    try {
      var res = await apiFetch(XK_BASE + "/models", { signal: t.signal });
      if (res.ok) {
        var d = await res.json();
        catalog = ((d && d.data) || []).filter(function (m) { return m && m.id; });
      }
    } catch (e) {}
    finally { t.done(); }

    xkCaps = {};
    catalog.forEach(function (m) {
      var c = m.capabilities || {};
      var re = m.reasoning_efforts || null;
      var levels = (re && Array.isArray(re.levels))
        ? re.levels.map(function (v) { return String(v).toLowerCase(); }) : [];
      xkCaps[m.id] = {
        vision: !!c.vision, tools: !!c.tools, reasoning: !!c.reasoning,
        efforts: levels, effortDefault: re && re.default ? String(re.default).toLowerCase() : "",
        tier: m.access_tier || "",
        modality: m.modality || "",
        priceIn: m.pricing && m.pricing.input != null ? Number(m.pricing.input) : null
      };
    });

    var okCount = 0, first = null, firstErr = null;
    for (var i = 0; i < keys.length; i++) {
      try {
        var q = await xkUsage(keys[i], signal);
        okCount++;
        if (!first) first = { q: q, i: i };
      } catch (e) { if (!firstErr) firstErr = e; }
    }
    if (!first) throw firstErr;
    if (!("xkiro" in lastKeyIdx)) lastKeyIdx.xkiro = first.i;

    var models = catalog.map(function (m) { return m.id; });
    models.sort(cmpModel());
    if (models.length === 0) models = PROVIDERS.xkiro.suggest.slice();
    return {
      ok: true, models: models.slice(0, 120), xquota: first.q, best: bestModel(),
      keysOk: okCount, keysTotal: keys.length, keyIndex: first.i
    };
  }

  // Catat model yang BENAR-BENAR menjawab (XKiro aggregate capabilities per
  // model, tapi provider spesifik di belakangnya bisa berbeda).
  var remoteNote = { requested: "", got: "", provider: "" };
  function noteRemote(d, requested) {
    try {
      var got = d && d.model ? String(d.model) : "";
      var prov = "";
      try { prov = d && d.provider ? String(d.provider) : ""; } catch (e) {}
      if (got) remoteNote = { requested: String(requested || ""), got: got, provider: prov };
    } catch (e) {}
  }
  function remoteModelNote() {
    var n = remoteNote;
    if (!n.got) return "";
    var same = !n.requested || n.got === n.requested;
    var p = n.provider ? " lewat " + n.provider : "";
    return same ? "" : "PERHATIAN: jawaban came dari model \"" + n.got + "\"" + p + ", bukan \"" + n.requested + "\".";
  }

  function xkIsReasoning(model) {
    var c = xkCaps[model];
    if (c) return !!c.reasoning;
    return /reason|thinking|deepseek|qwq/i.test(String(model || ""));
  }

  function xkVisionParts(batchQs, batchImgs) {
    if (batchImgs.length === 0) return buildPrompt(batchQs);
    var parts = [{ type: "text", text: buildPrompt(batchQs) }];
    batchImgs.forEach(function (im) {
      var url = im.b64 ? ("data:" + (im.mime || "image/png") + ";base64," + im.b64) : im.url;
      parts.push({ type: "image_url", image_url: { url: url } });
    });
    return parts;
  }

  // trim = tingkat arsitektur body saat 400 (param tidak didukung):
  //   0 = penuh (temperature + response_format + reasoning_effort)
  //   1 = tanpa reasoning_effort
  //   2 = tanpa response_format
  //   3 = minimal (tanpa temperature)
  //   4 = tanpa gambar (kalau error menyangkut image/vision/base64)
  // Code lama hanya jujur pada 2 pola; sisanya 400 -> "gagal menjawab".
  async function xkBatch(apiKey, model, batchQs, batchImgs, signal, trim, effort) {
    trim = trim || 0;
    if (!String(model || "").trim()) throw new Error("Model kosong — pilih model di Pengaturan lalu klik Test.");
    var key = String(apiKey || "").trim();
    var t = withTimeout(signal, 90000);
    try {
      var body = {
        model: model, max_tokens: 800,
        messages: [
          { role: "system", content: "You are a fast form-solving assistant. Return valid JSON only. Keep short answers short." },
          { role: "user", content: (trim >= 4) ? buildPrompt(batchQs) : xkVisionParts(batchQs, batchImgs) }
        ]
      };
      if (trim < 3 && !xkIsReasoning(model)) body.temperature = 0;
      if (trim < 2) body.response_format = { type: "json_object" };
      if (trim < 1) applyEffort(body, effort);

      var res = await apiFetch(XK_BASE + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        signal: t.signal, body: JSON.stringify(body)
      });
      if (!res.ok) {
        var tx = ""; try { tx = await res.text(); } catch (e) {}
        // 400 = param tidak didukung model/gateway -> sederhanakan body bertahap.
        if (res.status === 400 && trim < 4) {
          var next = trim + 1;
          if (/image|vision|base64|multimodal|media|url/i.test(tx)) next = 4;
          t.done();
          return xkBatch(apiKey, model, batchQs, batchImgs, signal, next, effort);
        }
        if (res.status === 401 || res.status === 403) throw new Error("API key XKiro invalid.");
        if (res.status === 402) throw new Error("Saldo XKiro habis (402). Top-up / tunggu reset.");
        if (res.status === 404) throw new Error(missingModelMsg(model));
        if (res.status === 429) throw new Error(rateLimitMsg(model, tx));
        throw new Error("XKiro HTTP " + res.status + ". " + tx.slice(0, 300));
      }
      var d = await res.json();
      noteRemote(d, model);
      var c = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : "";
      if (typeof c !== "string") c = JSON.stringify(c || "");
      if (!c) throw new Error("Respons XKiro kosong.");
      return c;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("Dibatalkan (Stop).");
      if (e instanceof TypeError) throw new Error("Tidak bisa menghubungi XKiro. Periksa internet.");
      throw e;
    } finally { t.done(); }
  }

  // ---------- Multi-key: parsing + rotasi auto-failover ----------
  function asKeys(v) {
    var arr = Array.isArray(v) ? v : [v];
    var seen = {}, out = [];
    arr.forEach(function (x) {
      String(x == null ? "" : x).split(/\r?\n/).forEach(function (ln) {
        var k = ln.trim();
        if (k && !seen[k]) { seen[k] = 1; out.push(k); }
      });
    });
    return out;
  }

  var keyCursor = {};  // posisi mulai per provider (sticky antar request)
  var lastKeyIdx = {}; // key terakhir yang sukses per provider (untuk indikator UI)

  function isAuthError(msg) {
    return /401|403|invalid(\s|-)?api.?key|unauthorized|forbidden|authentication_error/i.test(String(msg || ""));
  }

  // Coba key satu per satu (mulai dari cursor). Pindah bila limit (429) atau
  // key invalid. Error lain (model salah, bad request) langsung dilempar.
  async function callWithRotation(provider, keys, signal, callOne) {
    if (!keys || !keys.length) throw new Error("API key kosong. Isi 1 key atau lebih (1 per baris).");
    if (!(provider in keyCursor)) keyCursor[provider] = 0;
    if (!(provider in lastKeyIdx)) lastKeyIdx[provider] = 0;
    var start = keyCursor[provider] % keys.length; // titik awal tetap selama putaran
    var tried = [];
    for (var n = 0; n < keys.length; n++) {
      var idx = (start + n) % keys.length;
      try {
        var out = await callOne(keys[idx], signal);
        keyCursor[provider] = idx;
        lastKeyIdx[provider] = idx;
        return { out: out, idx: idx };
      } catch (e) {
        tried.push(e);
        var msg = (e && e.message) || String(e);
        if (!isLimitError(msg) && !isAuthError(msg)) throw e;
      }
    }
    var allLimit = tried.every(function (e) { return isLimitError((e && e.message) || ""); });
    if (allLimit) {
      // Pakai pesan paling spesifik (rate limit gratis vs kuota) — jangan
      // menyuruh "tambah key" dulu saat masalahnya batas request.
      var first = tried[0] && (tried[0].message || String(tried[0]));
      if (keys.length === 1) throw new Error(first);
      throw new Error("Semua " + keys.length + " key kena 429. " + first);
    }
    throw tried[tried.length - 1];
  }

  // ---------- Vision: deteksi model support gambar ----------
  function isVisionModel(provider, model) {
    var m = String(model || "");
    if (xkCaps && (m in xkCaps)) return !!xkCaps[m].vision;
    return /vision|vl-|gemini|gpt|claude|llama|mistral|qwen|command|aya|grok|deepseek|minimax|sensenova|flash|mini|small/i.test(m);
  }

  // ---------- Snap jawaban ke teks opsi (anti "B" vs "Jakarta") ----------
  function normQ(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
  }
  function snapOne(opts, want) {
    var w = normQ(want);
    if (!w) return "";
    for (var i = 0; i < opts.length; i++) if (normQ(opts[i]) === w) return opts[i];
    // Buang imbuhan teknis seperti " (24)", "2", "B)" supaya "Opsi 2" tetap cocok.
    var strip = function (s) { return normQ(s).replace(/[.:;,)\]]+$/, "").replace(/\s*\(([^)]*)\)\s*$/, ""); };
    var ws = strip(want);
    for (var a = 0; a < opts.length; a++) if (strip(opts[a]) === ws && ws) return opts[a];
    for (var b = 0; b < opts.length; b++) {
      var o = normQ(opts[b]);
      if (o && (o.indexOf(w) !== -1 || w.indexOf(o) !== -1)) return opts[b];
    }
    return String(want);
  }

  // Bersihkan jawaban: snap ke opsi, buang basa-basi, potong kalimat.
  function tightenAnswers(questions, answers) {
    return (answers || []).map(function (a) {
      var w = normQ(a.question);
      if (!w) return a;
      var q = null;
      for (var i = 0; i < questions.length; i++) {
        var t = normQ(questions[i].question);
        if (t === w || (t && w && (t.indexOf(w) !== -1 || w.indexOf(t) !== -1))) { q = questions[i]; break; }
      }
      if (!q) return a;
      var opts = q.options || [];
      if ((q.type === "multiple_choice" || q.type === "dropdown" || q.type === "true_false") && opts.length > 0) {
        var s = (typeof a.answer === "string") ? a.answer : String((a.answer && a.answer[0]) || "");
        return { question: a.question, answer: snapOne(opts, s) };
      }
      if (q.type === "checkbox" && opts.length > 0 && Array.isArray(a.answer)) {
        return { question: a.question, answer: a.answer.map(function (x) { return snapOne(opts, x); }) };
      }
      if ((q.type === "short_answer" || q.type === "paragraph") && typeof a.answer === "string") {
        var t2 = a.answer.replace(/^(jawaban|jawab|answer|response|hasil)\s*[:\-–]\s*/i, "").trim();
        if (q.type === "short_answer") {
          for (var f = 0; f < 3; f++) {
            var cut = t2.replace(/^(menurut saya|jawabannya adalah|jawabannya|hasilnya adalah|hasilnya|yaitu)\s+/i, "").trim();
            if (cut === t2) break;
            t2 = cut;
          }
          t2 = t2.split(/[.!?]\s/)[0];
          var words = t2.split(/\s+/).filter(Boolean);
          if (words.length > 12) t2 = words.slice(0, 12).join(" ");
        }
        return { question: a.question, answer: t2 };
      }
      return a;
    });
  }

  // ---------- Orkestrasi: batch paralel ----------
  // imageData: Map(url -> {b64, mime} | null). null = gagal unduh -> URL ditulis di prompt.
  async function solve(provider, settings, questions, imageData, signal, onProgress) {
    var cfg = PROVIDERS[provider];
    if (!cfg) throw new Error("Provider tidak dikenal: " + provider);
    var model = String(settings.model || "").trim() || bestModel() || cfg.defaultModel;
    if (!model) {
      throw new Error("Model belum dipilih. Buka Pengaturan → pilih model (atau isi Custom model) → klik Test XKiro.");
    }
    if (!Array.isArray(questions) || questions.length === 0) throw new Error("Tidak ada pertanyaan.");

    // Model tersimpan bisa sudah DIHAPUS XKiro. Tanpa guard ini semua request
    // 404 dan form tak terisi. Ganti ke model live dari katalog + catat.
    if (!modelExists(model)) {
      var alt = bestModel();
      if (!alt) throw new Error(missingModelMsg(model));
      model = alt;
      remoteNote = { requested: String(settings.model || ""), got: alt, provider: "auto-ganti" };
    }

    var batches = chunk(questions, cfg.batchSize).map(function (qs) {
      var b64 = [], imgs = [], withUnresolved = qs.map(function (q) {
        var copy = { question: q.question, type: q.type, options: q.options || [], images: [] };
        var un = [];
        (q.images || []).forEach(function (u) {
          var hit = imageData ? imageData.get(u) : null;
          if (hit && hit.b64) { b64.push(hit.b64); imgs.push(hit); }
          else un.push(u);
        });
        copy.unresolvedImages = un;
        return copy;
      });
      return { qs: withUnresolved, b64: b64, imgs: imgs };
    });

    var done = 0;
    var keys = (settings.keys && settings.keys.length) ? settings.keys : asKeys(settings.apiKey);
    var effort = normEffort(settings.effort);
    // Model gratis punya batas request. Paralel 4 + retry trim bisa menembak
    // batas itu. Turunkan concurrency & beri jeda antar batch.
    var free = isFreeModel(model);
    var conc = free ? Math.min(cfg.concurrency, 2) : cfg.concurrency;
    var gap = free ? 400 : 0;
    var launchAt = 0;

    var parts = await mapPool(batches, conc, async function (b) {
      if (gap) {
        var wait = launchAt - Date.now();
        if (wait > 0) await sleep(wait);
        launchAt = Date.now() + gap;
      }
      var rr = await callWithRotation(provider, keys, signal, function (key, sig) {
        return xkBatch(key, model, b.qs, b.imgs, sig, 0, effort);
      });
      var ans = parseAnswers(rr.out);
      done += b.qs.length;
      if (onProgress) { try { onProgress(done, questions.length); } catch (e) {} }
      return ans;
    }, signal);

    var out = [];
    parts.forEach(function (arr) { (arr || []).forEach(function (a) { out.push(a); }); });
    out = tightenAnswers(questions, out);
    if (out.length === 0) throw new Error("AI tidak mengembalikan jawaban.");
    return out;
  }

  async function testConnection(provider, settings, signal) {
    var keys = (settings.keys && settings.keys.length) ? settings.keys : asKeys(settings.apiKey);
    return xkTest(keys, signal);
  }

  window.AI = {
    PROVIDERS: PROVIDERS,
    isLimitError: isLimitError,
    getQuota: getQuota,
    lastKeyIndex: function (p) { return lastKeyIdx[p] || 0; },
    defaultModel: function () { return bestModel() || (PROVIDERS.xkiro.suggest[0] || ""); },
    suggestModels: function () { return (PROVIDERS.xkiro.suggest || []).slice(); },
    defaultVisionModel: function () {
      var ids = catalogIds().filter(function (id) { return modelIsVision("xkiro", id); });
      if (ids.length === 0) return PROVIDERS.xkiro.defaultVision || bestModel() || "";
      ids.sort(cmpModel());
      return ids[0];
    },
    isVisionModel: isVisionModel,
    effortLevels: effortLevels,
    effortLabel: effortLabel,
    effortDefault: effortDefault,
    remoteModelNote: remoteModelNote,
    modelIsReasoning: modelIsReasoning,
    modelExists: function (p, m) { return modelExists(m); },
    bestModel: function () { return bestModel(); },
    catalogLoaded: function () { return catalogLoaded(); },
    modelIsVision: modelIsVision,
    testConnection: testConnection,
    solve: solve,
    buildPrompt: buildPrompt,
    parseAnswers: parseAnswers
  };
})();

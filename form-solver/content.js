/* Form Solver - content.js
 * Berjalan di halaman Google Forms.
 * - Deteksi form, baca soal terlihat (+ gambar soal), isi jawaban (TANPA auto-submit).
 * - Dropdown: buka menu overlay -> tunggu opsi (polling) -> klik opsi -> verifikasi.
 * - Radio/checkbox: klik -> verifikasi aria-checked -> ulangi bila gagal.
 * Komunikasi: dipakai langsung oleh widget.js via window.RazorEngine
 *   PING -> {isForm} | ANALYZE -> {questions, imageCount} | FILL -> {filled,...}
 */
(function () {
  "use strict";

  // ---------- Util ----------
  function normalize(s) {
    return String(s == null ? "" : s).toLowerCase().trim().replace(/\s+/g, " ");
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function isGoogleForm() {
    var h = location.hostname || "";
    var p = location.pathname || "";
    if (h === "docs.google.com" && p.indexOf("/forms/") !== -1) return true;
    if (h === "forms.gle") return true;
    if (document.querySelector('div[role="listitem"], form[action*="forms"]')) {
      if (h.indexOf("google.com") !== -1 || h === "forms.gle") return true;
    }
    return false;
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
    return true;
  }

  function questionTextOf(item) {
    var cands = [
      '[role="heading"] span.M7eMe',
      '[role="heading"] span',
      '[role="heading"]',
      'span.M7eMe',
      'div.AgroKb span',
      'div.AgroKb'
    ];
    for (var i = 0; i < cands.length; i++) {
      var el = item.querySelector(cands[i]);
      if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
    }
    return "";
  }

  // Teks aman untuk elemen yang belum ter-render: innerText kosong saat
  // display:none / sedang animasi -> fallback ke textContent.
  function textOf(el) {
    if (!el) return "";
    var t = el.innerText;
    if (t == null || !String(t).trim()) t = el.textContent;
    return String(t || "").trim();
  }
  function firstLine(s) { return String(s || "").replace(/\s+/g, " ").trim().split(" / ")[0].trim(); }

  function optionLabel(el) {
    if (!el) return "";
    var aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    var sels = [".ocf-atf-T", "[class*='atf-T']", "span.aDTYNe", "span.nEMz3e", "span.ulDsOb", "span"];
    for (var i = 0; i < sels.length; i++) {
      var n = null;
      try { n = el.querySelector(sels[i]); } catch (e) {}
      var t = firstLine(textOf(n));
      if (t) return t;
    }
    var dv = el.getAttribute && el.getAttribute("data-value");
    if (dv && String(dv).trim()) return String(dv).trim();
    return firstLine(textOf(el));
  }

  // Placeholder dropdown Google ("Pilih"/"Choose"/"Select"). Pernah lolos jadi
  // satu-satunya opsi -> AI Menjawab "Pilih" dan dropdown tetap kosong.
  var PLACEHOLDERS = ["pilih", "choose", "select", "none", "kosong"];
  function isPlaceholder(label) {
    var n = normalize(label).replace(/[.:…\-]+$/, "").trim();
    if (!n) return true;
    if (PLACEHOLDERS.indexOf(n) !== -1) return true;
    return n.length <= 14 && /^(pilih|choose|select|pilihan|opsi)\b/.test(n);
  }

  // Gambar milik soal (untuk model vision). Hanya <img> berukuran wajar.
  function imagesOf(item) {
    var out = [], seen = {};
    var imgs = item.querySelectorAll ? item.querySelectorAll("img") : [];
    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].currentSrc || imgs[i].src || "";
      if (!src || seen[src]) continue;
      if (!/^https?:\/\//i.test(src)) continue;
      if (/transparent|blank|spacer|pixel/i.test(src)) continue;
      try {
        var r = imgs[i].getBoundingClientRect();
        if (r.width < 24 || r.height < 24) continue;
      } catch (e) { continue; }
      seen[src] = 1;
      out.push(src);
    }
    return out;
  }

  // ---------- Klik kuat: hover + pointer + mouse + click ----------
  function pressEvents(el, x, y) {
    var o = { bubbles: true, cancelable: true, view: window, detail: 1 };
    if (typeof x === "number") { o.clientX = x; o.clientY = y; }
    try { el.dispatchEvent(new MouseEvent("mouseover", o)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("mouseenter", o)); } catch (e) {}
    try {
      var po = { bubbles: true, cancelable: true, view: window, detail: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
      if (typeof x === "number") { po.clientX = x; po.clientY = y; }
      el.dispatchEvent(new PointerEvent("pointerdown", po));
    } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("mousedown", o)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("mouseup", o)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("click", o)); } catch (e) {}
    try { el.click(); } catch (e) {}
  }

  function pressElement(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    pressEvents(el);
  }

  // Untuk opsi di menu overlay: TANPA scroll halaman (scroll menutup menu Google
  // sehingga klik jatuh ke udara — penyebab utama "dropdown ga ke-klik").
  // Klik diarahkan ke ANAK TERDALAM di titik tengah opsi (listener Google
  // sering menempel di span/ripple, bukan di container [role=option]),
  // lalu ke containernya, lengkap dengan koordinat.
  function deepestAt(el) {
    try {
      var r = el.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var t = document.elementFromPoint(x, y);
      if (t && t !== document.body && t !== document.documentElement) return { el: t, x: x, y: y };
    } catch (e) {}
    return { el: el, x: undefined, y: undefined };
  }

  function pressMenuOption(el) {
    if (!el) return;
    var d = deepestAt(el);
    pressEvents(d.el, d.x, d.y);
    if (d.el !== el) pressEvents(el, d.x, d.y);
  }

  function closeMenu() {
    try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })); } catch (e) {}
    try { if (document.activeElement) document.activeElement.blur(); } catch (e) {}
  }

  // Menu overlay yang terbuka (punya ukuran) — untuk deteksi menu nyangkut.
  function countOpenOptions() {
    var nodes = optionNodes();
    var c = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (measured(nodes[i])) c++;
    }
    return c;
  }

  // Tutup PAKSA semua menu overlay (Escape berkali-kali + klik netral di body
  // agar outside-click handler Google jalan + verifikasi sampai 0).
  // Dipanggil sebelum tiap buka menu & tiap ganti soal — anti menu menumpuk.
  async function closeAllMenus() {
    for (var i = 0; i < 4; i++) {
      if (countOpenOptions() === 0) return true;
      try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })); } catch (e) {}
      await sleep(120);
      if (countOpenOptions() === 0) return true;
      try {
        var o = { bubbles: true, cancelable: true, view: window };
        document.body.dispatchEvent(new MouseEvent("mousedown", o));
        document.body.dispatchEvent(new MouseEvent("mouseup", o));
      } catch (e) {}
      await sleep(150);
    }
    try { if (document.activeElement) document.activeElement.blur(); } catch (e) {}
    return countOpenOptions() === 0;
  }

  // ---------- Dropdown: pemetik opsi (multi-selector) ----------
  // Google Forms berganti-ganti implementasi listbox antar versi:
  //   [role=option] | [role=menuitemradio] | [role=menuitem] | <li data-value>
  // Semuanya dicoba. Placeholder ("Pilih") SELALU dibuang — bukan hanya saat
  // out.length > 1. Itulah bug "AI jawab Pilih": menu baru terisi placeholder
  // saat dibaca, jadi [ "Pilih" ] terkirim ke AI.
  var OPTION_SELECTORS = [
    '[role="option"]',
    '[role="menuitemradio"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitem"]',
    'li[data-value]',
    '[data-value][jsname]'
  ];
  var TRIGGER_ROLES = { listbox: 1, menu: 1, combobox: 1, textbox: 1, dialog: 1 };

  function measured(el) {
    try {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }

  // Kandidat node opsi, unik, dan bukan pemicu dropdown itu sendiri
  // (pemicu juga role=listbox/combobox, lalu tanpa filter ikut terambil).
  function optionNodes() {
    var seen = {}, out = [];
    for (var i = 0; i < OPTION_SELECTORS.length; i++) {
      var nodes = [];
      try { nodes = document.querySelectorAll(OPTION_SELECTORS[i]); } catch (e) { continue; }
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (seen[n]) continue;
        seen[n] = 1;
        var role = "";
        try { role = n.getAttribute("role") || ""; } catch (e) {}
        if (TRIGGER_ROLES[role]) continue;
        out.push(n);
      }
    }
    return out;
  }

  function menuOptionsRaw() {
    var nodes = optionNodes();
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var label = optionLabel(el);
      if (!label || isPlaceholder(label)) continue;
      var dv = "";
      try { dv = (el.getAttribute("data-value") || "").trim(); } catch (e) {}
      out.push({ el: el, label: label, value: dv || label });
    }
    // Utamakan yang TERUKUR: Google menyimpan template menu tersembunyi di DOM.
    var vis = out.filter(function (o) { return measured(o.el); });
    if (vis.length > 0) out = vis;
    // Unik, jaga urutan
    var seen = {}, uniq = [];
    out.forEach(function (o) {
      var k = normalize(o.label);
      if (seen[k]) return;
      seen[k] = 1; uniq.push(o);
    });
    return uniq;
  }

  // Opsi yang sudah DIPILIH (dipakai verifikasi klik).
  function selectedOptionLabel() {
    var nodes = optionNodes();
    for (var i = 0; i < nodes.length; i++) {
      var sel = "";
      try { sel = nodes[i].getAttribute("aria-selected") || ""; } catch (e) {}
      if (sel === "true") return optionLabel(nodes[i]);
    }
    return "";
  }

  // Scroll "nearest" agar tidak menggeser halaman (menu overlay Google
  // sensitif: scroll halaman bisa menutup menu sebelum klik mendarat).
  // Scroll HANYA di dalam menu (wadah scroll-nya), tak pernah window —
  // scroll window menutup overlay Google sehingga klik jatuh ke udara.
  function scrollMenuOnly(el) {
    try {
      var p = el.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        var st = window.getComputedStyle(p);
        if (/(auto|scroll)/.test(st.overflowY || "") && p.scrollHeight > p.clientHeight + 4) {
          var r = el.getBoundingClientRect(), pr = p.getBoundingClientRect();
          if (r.top < pr.top) p.scrollTop -= (pr.top - r.top);
          else if (r.bottom > pr.bottom) p.scrollTop += (r.bottom - pr.bottom);
          return;
        }
        p = p.parentElement;
      }
    } catch (e) {}
  }

  // Tunggu menu TERISI PENUH. Google merender opsi bertahap; sebelumnya kita
  // kembali begitu opts.length > 0 — sering kali baru ada placeholder "Pilih",
  // sehingga AI Menjawab "Pilih" dan dropdown tak terisi.
  // Kriteria siap: >= readyMin opsi nyata, ATAU jumlah opsi stabil 2 polling beruntun.
  async function pollMenuOptions(readyMin) {
    var min = readyMin || 2;
    var lastCount = -1, stable = 0;
    for (var i = 0; i < 22; i++) { // ~3.5 dtk
      await sleep(150);
      var opts = menuOptionsRaw();
      var n = opts.length;
      if (n === 0) { lastCount = 0; stable = 0; continue; }
      if (n >= min) return opts;
      if (n === lastCount) stable++;
      else { stable = 0; lastCount = n; }
      if (stable >= 2) return opts; // dropdown 1-2 opsi: tetap lanjut, bukan menggantung
    }
    return [];
  }

  // Node bukan pemicu bila berada di LUAR container soal: menu overlay Google
  // disuntik ke <body>, sedangkan pemicu selalu di dalam div[role="listitem"].
  function isOverlayNode(el) {
    var n = el;
    while (n && n !== document.body && n !== document.documentElement) {
      try { if (n.getAttribute && n.getAttribute("role") === "listitem") return false; } catch (e) {}
      n = n.parentElement;
    }
    return true;
  }

  // Cari pemicu dropdown: role standar dulu, lalu jsname khas Google
  // (mis. div[jsname="d9BH4c"]), lalu aria-haspopup/combobox. Menu overlay
  // juga role=listbox, jadi lewati yang berada di dalam wadah overlay.
  function findListbox(container) {
    var sels = ['[role="listbox"]', 'div[jsname="d9BH4c"]', '[aria-haspopup="listbox"]',
                '[role="combobox"]', '[aria-haspopup="menu"]', '[aria-expanded]'];
    for (var i = 0; i < sels.length; i++) {
      var nodes = [];
      try { nodes = container.querySelectorAll(sels[i]); } catch (e) { continue; }
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        if (!visible(el)) continue;
        if (isOverlayNode(el)) continue; // bukan pemicu, tapi menu yang kebetulan nyangkut
        return el;
      }
    }
    return null;
  }

  // Gaya console: klik polos pembuka -> tunggu menu PENUH -> klik polos opsi.
  // Cepat bila DOM standar; gagal diam-diam bila tidak.
  async function consoleStyleSelect(listbox, target) {
    var opts = await ensureMenuOpen(listbox);
    if (opts.length === 0) { closeMenu(); return false; }
    var hi = matchIdx(opts, target);
    if (hi === -1) { closeMenu(); return false; }
    var hit = opts[hi].el;
    try { hit.click(); } catch (e) { closeMenu(); return false; }
    var v = await waitListboxValue(listbox, target, 1500);
    closeMenu();
    return !!v;
  }

  async function ensureMenuOpen(listbox) {
    await closeAllMenus(); // mulai bersih: tak ada menu soal lain yang terbuka
    var openers = [listbox];
    try {
      var inner = listbox.querySelector("div, span");
      if (inner && inner !== listbox) openers.push(inner);
    } catch (e) {}
    for (var attempt = 0; attempt < openers.length + 1; attempt++) {
      pressElement(openers[attempt % openers.length]);
      var opts = await pollMenuOptions();
      if (opts.length > 0) return opts;
      closeMenu();
      await sleep(200);
    }
    return [];
  }

  async function readDropdownOptions(listbox) {
    await closeAllMenus();
    await sleep(120);
    var opts = await ensureMenuOpen(listbox);
    await closeAllMenus();
    await sleep(120);
    return opts.map(function (o) { return o.label; });
  }

  // ---------- Baca satu item ----------
  async function readItem(item) {
    var q = questionTextOf(item);
    if (!q) return null;
    var images = imagesOf(item);

    var visRadios = Array.prototype.filter.call(item.querySelectorAll('[role="radio"]'), visible);
    if (visRadios.length > 0) {
      var opts = visRadios.map(optionLabel).filter(Boolean);
      if (opts.length === 0) return null;
      var onlyTF = opts.length === 2 && opts.every(function (o) {
        return ["true", "false", "benar", "salah", "ya", "tidak"].indexOf(normalize(o)) !== -1;
      });
      return { question: q, type: onlyTF ? "true_false" : "multiple_choice", options: opts, images: images };
    }

    var visChecks = Array.prototype.filter.call(item.querySelectorAll('[role="checkbox"]'), visible);
    if (visChecks.length > 0) {
      var copts = visChecks.map(optionLabel).filter(Boolean);
      if (copts.length === 0) return null;
      return { question: q, type: "checkbox", options: copts, images: images };
    }

    var listbox = findListbox(item);
    if (listbox) {
      var dopts = [];
      try { dopts = await readDropdownOptions(listbox); } catch (e) { dopts = []; }
      return { question: q, type: "dropdown", options: dopts, images: images };
    }

    var textarea = item.querySelector("textarea");
    if (textarea && visible(textarea)) return { question: q, type: "paragraph", options: [], images: images };

    var textInput = item.querySelector('input[type="text"], input:not([type])');
    if (textInput && visible(textInput)) return { question: q, type: "short_answer", options: [], images: images };

    if (images.length > 0) return { question: q, type: "short_answer", options: [], images: images };
    return null;
  }

  async function extractQuestions() {
    if (!isGoogleForm()) throw new Error("Google Form tidak ditemukan. Buka halaman docs.google.com/forms milik Anda.");
    var items = document.querySelectorAll('div[role="listitem"]');
    if (!items || items.length === 0) throw new Error("Tidak ada pertanyaan. Pastikan form sudah terbuka dan terlihat.");
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (!visible(items[i])) continue;
      try {
        var q = await readItem(items[i]);
        if (q && q.question) out.push(q);
      } catch (e) { /* lewati item rusak */ }
    }
    if (out.length === 0) throw new Error("Tidak ada pertanyaan yang didukung.");
    var imgCount = out.filter(function (q) { return q.images && q.images.length > 0; }).length;
    return { questions: out, imageCount: imgCount };
  }

  // ---------- Matching toleran ----------
  // Cocokkan target ke label ATAU data-value opsi (ListItem menyimpan
  // nilai bersih di data-value; teks kadang berlebih spasi/format).
  function matchIdx(opts, target) {
    var labels = opts.map(function (o) { return o.label; });
    var i = bestIndex(labels, target);
    if (i !== -1) return i;
    var vals = opts.map(function (o) { return o.value || o.label; });
    return bestIndex(vals, target);
  }

  function bestIndex(labels, wanted) {
    var w = normalize(wanted);
    if (!w) return -1;
    for (var i = 0; i < labels.length; i++) if (normalize(labels[i]) === w) return i;
    // Angka: "Tahun 1908" cocok dengan opsi "1908".
    var wd = w.replace(/\D+/g, "");
    if (wd) {
      for (var k = 0; k < labels.length; k++) {
        if (normalize(labels[k]).replace(/\D+/g, "") === wd) return k;
      }
    }
    for (var j = 0; j < labels.length; j++) {
      var o = normalize(labels[j]);
      if (o && (o.indexOf(w) !== -1 || w.indexOf(o) !== -1)) return j;
    }
    return -1;
  }

  function isChecked(el) { return el.getAttribute("aria-checked") === "true"; }

  // Klik dengan verifikasi: coba target, anak dalam, lalu label pembungkus.
  async function clickToCheck(el) {
    var cands = [el];
    try {
      var inner = el.querySelector("div, span");
      if (inner) cands.push(inner);
      var label = el.closest ? el.closest("label") : null;
      if (label && label !== el) cands.push(label);
    } catch (e) {}
    for (var a = 0; a < 3; a++) {
      pressElement(cands[a % cands.length]);
      await sleep(220);
      if (isChecked(el)) return true;
    }
    return isChecked(el);
  }

  function fillText(inputEl, text) {
    try { inputEl.scrollIntoView({ block: "center" }); } catch (e) {}
    try { inputEl.focus(); } catch (e) {}
    var proto = inputEl.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    try {
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(inputEl, String(text));
    } catch (e) { inputEl.value = String(text); }
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    try { inputEl.blur(); } catch (e) {}
  }

  function containers() {
    return Array.prototype.filter.call(document.querySelectorAll('div[role="listitem"]'), visible);
  }

  function findContainerFor(question) {
    var w = normalize(question), best = null, bestScore = -1;
    containers().forEach(function (c) {
      var t = normalize(questionTextOf(c));
      if (!t || !w) return;
      var s = -1;
      if (t === w) s = 3;
      else if (t.indexOf(w) !== -1 || w.indexOf(t) !== -1) s = 2;
      if (s > bestScore) { bestScore = s; best = c; }
    });
    return best;
  }

  // Nilai yang TAMPIL di pemicu. Mengambil node teks specific Google
  // (div[jsname="YPqjNb"] / .ocf-atf-T) supaya tidak ikut menelan teks lain.
  function listboxValue(listbox) {
    if (!listbox) return "";
    var sels = ['[jsname="YPqjNb"]', ".ocf-atf-T", "[class*='atf-T']"];
    for (var i = 0; i < sels.length; i++) {
      var n = null;
      try { n = listbox.querySelector(sels[i]); } catch (e) {}
      var t = firstLine(textOf(n));
      if (t) return normalize(t);
    }
    var dv = "";
    try { dv = (listbox.getAttribute("data-value") || "").trim(); } catch (e) {}
    var aria = "";
    try { aria = (listbox.getAttribute("aria-label") || "").trim(); } catch (e) {}
    var raw = firstLine(textOf(listbox)) || dv || aria;
    return normalize(raw);
  }

  // Tunggu nilai listbox berubah (lebih andal dari sleep fixed: cepat bila
  // sukses, toleran bila mesin lambat).
  // Return {text, exact}: exact=false berarti "ada nilai baru" tapi teksnya
  // tak sama persis dengan target — tetap dianggap berhasil (kode lama
  // menganggapnya gagal walau sebenarnya sudah terisi).
  async function waitListboxValue(listbox, target, timeoutMs) {
    var w = normalize(target);
    var t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      var cur = listboxValue(listbox);
      if (cur && !isPlaceholder(cur) &&
          (cur === w || cur.indexOf(w) !== -1 || w.indexOf(cur) !== -1)) {
        return { text: cur, exact: true };
      }
      await sleep(120);
    }
    var last = listboxValue(listbox);
    if (last && !isPlaceholder(last)) return { text: last, exact: false };
    return null;
  }

  // Semua item mentah TERMASUK placeholder — dipakai untuk navigasi keyboard
  // per indeks (Home + Panah xN), jadi harus urut sama persis dengan menu.
  // Utamakan yang terukur, abaikan template tersembunyi.
  function menuOptionsAll() {
    var nodes = optionNodes();
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var label = optionLabel(el);
      if (!label) continue;
      var dv = "";
      try { dv = (el.getAttribute("data-value") || "").trim(); } catch (e) {}
      out.push({ el: el, label: label, value: dv || label });
    }
    var vis = out.filter(function (o) { return measured(o.el); });
    return vis.length > 0 ? vis : out;
  }

  // Fallback keyboard deterministik: Home -> ArrowDown x N -> Enter.
  // Tak butuh klik sama sekali — andalan bila semua klik sintetis ditolak.
  async function keyboardIndexSelect(listbox, target) {
    var raw = menuOptionsAll();
    if (raw.length === 0) {
      var opened = await ensureMenuOpen(listbox);
      if (opened.length === 0) return false;
      raw = menuOptionsAll();
    }
    var idx = matchIdx(raw, target);
    if (idx === -1) return false;
    try {
      var host = document.activeElement || document.body;
      host.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", keyCode: 36, which: 36, bubbles: true, cancelable: true }));
      await sleep(180);
      for (var k = 0; k < idx; k++) {
        (document.activeElement || host).dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", keyCode: 40, which: 40, bubbles: true, cancelable: true }));
        await sleep(90);
      }
      (document.activeElement || host).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    } catch (e) {}
    var v = await waitListboxValue(listbox, target, 1500);
    closeMenu();
    return !!v;
  }

  // Bonus: sebagian form menyimpan nilai di input hidden entry.* — coba isi langsung.
  async function hiddenInputSelect(container, listbox, target) {
    try {
      var hiddens = container.querySelectorAll('input[type="hidden"]');
      for (var i = 0; i < hiddens.length; i++) {
        var h = hiddens[i];
        if ((h.getAttribute("name") || "").indexOf("entry") !== 0) continue;
        try { if (h.focus) h.focus(); } catch (e) {}
        try {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(h, String(target));
        } catch (e) { h.value = String(target); }
        h.dispatchEvent(new Event("input", { bubbles: true }));
        h.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(200);
        if (await waitListboxValue(listbox, target, 800)) return true;
      }
    } catch (e) {}
    return false;
  }
  // Type-ahead: ketik teks opsi di menu terbuka, lalu Enter.
  async function keyboardSelect(listbox, target) {
    var opts = await ensureMenuOpen(listbox);
    if (opts.length === 0) return false;
    var focusEl = null;
    try {
      var menu = opts[0].el.closest ? opts[0].el.closest('[role="menu"], [role="presentation"]') : null;
      focusEl = (menu && menu.focus) ? menu : opts[0].el;
      if (focusEl.tabIndex < 0) { try { focusEl.tabIndex = -1; } catch (e) {} }
      if (focusEl.focus) focusEl.focus();
    } catch (e) {}
    focusEl = document.activeElement || focusEl || document.body;
    var text = String(target);
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      try { focusEl.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true })); } catch (e) {}
      try { focusEl.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true, cancelable: true })); } catch (e) {}
      try { focusEl.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true })); } catch (e) {}
      await sleep(30);
    }
    await sleep(250);
    try {
      (document.activeElement || focusEl).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    } catch (e) {}
    var v = await waitListboxValue(listbox, target, 1500);
    closeMenu();
    return !!v;
  }

  async function fillDropdown(container, want) {
    var target = Array.isArray(want) ? String(want[0]) : String(want);
    // Jawaban "Pilih/Choose" bukan jawaban — jangan pernah diklik.
    if (isPlaceholder(target)) return { ok: false, reason: "Jawaban AI cuma placeholder (\"" + target + "\") — pilih manual." };
    var listbox = findListbox(container);
    if (!listbox) return { ok: false, reason: "Dropdown tidak ditemukan." };
    await closeAllMenus(); // isolasi: tutup sisa menu soal sebelumnya
    await sleep(120);
    var sawMenu = false, lastLabels = [], attempts = ["klik-console"];

    // Ronde -1: gaya console (klik polos + cocok persis) — tercepat bila DOM standar.
    try {
      if (await consoleStyleSelect(listbox, target)) {
        return { ok: true, picked: target };
      }
    } catch (e) {}

    // Ronde 0-1: klik mouse (sequence penuh ke anak terdalam, lalu klik polos).
    for (var round = 0; round < 2; round++) {
      var opts = await ensureMenuOpen(listbox);
      if (opts.length === 0) { attempts.push("buka-menu-gagal"); closeMenu(); await sleep(150); continue; }
      sawMenu = true;
      var labels = opts.map(function (o) { return o.label; });
      lastLabels = labels;
      var idx = matchIdx(opts, target);
      if (idx === -1) {
        // Opsi mungkin hanya terbaca sebagian -> coba ulang dgn daftar penuh.
        var full = menuOptionsAll();
        var idx2 = matchIdx(full, target);
        if (idx2 !== -1 && full[idx2].el && document.contains(full[idx2].el)) {
          var o2 = full[idx2].el;
          scrollMenuOnly(o2);
          await sleep(120);
          pressMenuOption(o2);
          attempts.push("klik-daftar-penuh");
          var v2 = await waitListboxValue(listbox, target, 2000);
          closeMenu();
          await sleep(120);
          if (v2) return { ok: true, picked: full[idx2].label };
          continue;
        }
        closeMenu();
        return { ok: false, reason: "AI jawab \"" + target + "\" — tak cocok. Opsi: [" + labels.join(" | ") + "]" };
      }
      var optEl = opts[idx].el;
      // Elemen bisa re-render (detached) antara baca & klik -> query ulang.
      if (!document.contains(optEl)) {
        var fresh = menuOptionsRaw();
        var i2 = matchIdx(fresh, target);
        if (i2 === -1) { attempts.push("opsi-hilang"); closeMenu(); await sleep(150); continue; }
        optEl = fresh[i2].el;
      }
      scrollMenuOnly(optEl);
      await sleep(120);
      if (round === 0) {
        pressMenuOption(optEl);
        attempts.push("klik-seq");
      } else {
        try { if (optEl.focus) optEl.focus(); } catch (e) {}
        try { optEl.click(); } catch (e) {}
        attempts.push("klik-polos");
      }
      // Verifikasi: nilai di pemicu berubah ATAU opsi kena aria-selected.
      // Code lama memakai `if (v || selOk)` dengan v berupa string kosong saat
      // teks tak sama persis -> reporting "ok" walau dropdown masih kosong.
      var selOk = false;
      try { selOk = optEl.getAttribute("aria-selected") === "true"; } catch (e) {}
      if (!selOk) { var sl = selectedOptionLabel(); selOk = !!sl; }
      var v = await waitListboxValue(listbox, target, 2000);
      closeMenu();
      await sleep(120);
      if (v || selOk) return { ok: true, picked: v ? v.text : labels[idx] };
    }

    // Ronde 2: tulis langsung via hidden input entry.* (bila ada).
    if (await hiddenInputSelect(container, listbox, target)) {
      return { ok: true, picked: target };
    }
    attempts.push("hidden-input");

    // Ronde 3-4: keyboard (type-ahead, lalu navigasi indeks Home+Panah+Enter).
    if (await keyboardSelect(listbox, target)) return { ok: true, picked: target };
    attempts.push("keyboard-ketik");
    if (await keyboardIndexSelect(listbox, target)) return { ok: true, picked: target };
    attempts.push("keyboard-indeks");

    closeMenu();
    if (!sawMenu) return { ok: false, reason: "Menu dropdown tak terbuka (diklik, 0 opsi muncul). Scroll ke soal lalu ulangi." };
    return { ok: false, reason: "Menu terbuka (" + lastLabels.length + " opsi), \"" + target + "\" dicoba via [" + attempts.join(", ") + "] tapi nilai tak berubah. Pilih manual." };
  }

  async function fillOne(container, item) {
    var want = item.answer;

    var radios = Array.prototype.filter.call(container.querySelectorAll('[role="radio"]'), visible);
    if (radios.length > 0) {
      var labels = radios.map(optionLabel);
      var idx = bestIndex(labels, Array.isArray(want) ? String(want[0]) : String(want));
      if (idx === -1) return { ok: false, reason: "Jawaban tidak cocok dengan pilihan: " + want };
      var ok = await clickToCheck(radios[idx]);
      if (!ok) return { ok: false, reason: "Opsi tidak merespons klik (" + labels[idx] + "). Coba manual." };
      return { ok: true, picked: labels[idx] };
    }

    var checks = Array.prototype.filter.call(container.querySelectorAll('[role="checkbox"]'), visible);
    if (checks.length > 0) {
      var clabels = checks.map(optionLabel);
      var wants = Array.isArray(want) ? want.map(String) : [String(want)];
      var picked = [], missing = [];
      for (var i = 0; i < wants.length; i++) {
        var k = bestIndex(clabels, wants[i]);
        if (k === -1) { missing.push(wants[i]); continue; }
        if (!isChecked(checks[k])) {
          var cok = await clickToCheck(checks[k]);
          if (!cok) { missing.push(wants[i] + " (klik gagal)"); continue; }
        }
        picked.push(clabels[k]);
      }
      if (missing.length > 0) return { ok: picked.length > 0, picked: picked, reason: "Sebagian tidak cocok/gagal: " + missing.join("; ") };
      return { ok: true, picked: picked };
    }

    if (findListbox(container)) return fillDropdown(container, want);

    var textarea = container.querySelector("textarea");
    if (textarea && visible(textarea)) {
      var t1 = Array.isArray(want) ? want.join(", ") : String(want);
      fillText(textarea, t1);
      await sleep(120);
      return { ok: true, picked: t1 };
    }
    var textInput = container.querySelector('input[type="text"], input:not([type])');
    if (textInput && visible(textInput)) {
      var t2 = Array.isArray(want) ? want.join(", ") : String(want);
      fillText(textInput, t2);
      await sleep(120);
      return { ok: true, picked: t2 };
    }
    return { ok: false, reason: "Tipe soal tidak didukung untuk diisi otomatis." };
  }

  async function fillAnswers(answers) {
    if (!isGoogleForm()) throw new Error("Google Form tidak ditemukan.");
    if (!Array.isArray(answers) || answers.length === 0) throw new Error("Tidak ada jawaban dari AI untuk diisi.");
    var filled = 0, details = [], skipped = [];
    for (var i = 0; i < answers.length; i++) {
      var item = answers[i];
      var c = findContainerFor(item.question);
      if (!c) {
        skipped.push(item.question);
        details.push({ question: item.question, ok: false, reason: "Soal tidak ditemukan di halaman." });
        continue;
      }
      try {
        var r = await fillOne(c, item);
        await closeAllMenus(); // isolasi per soal: tak ada menu nyangkut ke soal berikut
        details.push({ question: item.question, ok: r.ok, picked: r.picked, reason: r.reason });
        if (r.ok) filled++; else skipped.push(item.question);
      } catch (e) {
        skipped.push(item.question);
        details.push({ question: item.question, ok: false, reason: (e && e.message) || String(e) });
      }
    }
    closeMenu();
    return { filled: filled, total: answers.length, skipped: skipped, details: details };
  }

  // ---------- Engine publik untuk widget dalam halaman ----------
  // Dipakai widget.js secara langsung (tanpa message passing).
  window.RazorEngine = {
    isGoogleForm: isGoogleForm,
    analyze: extractQuestions, // -> {questions, imageCount}
    fill: fillAnswers          // (answers) -> {filled, total, skipped, details}
  };
})();

<div align="center">

<img src="icons/icon128.png" alt="Form Solver" width="96" height="96">

# Form Solver

**Chrome Extension (MV3) — isi Google Form sendiri dengan bantuan AI, lalu Anda yang tetap menekan submit.**

[![Manifest V3](https://img.shields.io/badge/manifest-v3-4285F4?style=flat-square&logo=googlechrome)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Chrome 116+](https://img.shields.io/badge/chrome-116%2B-4285F4?style=flat-square&logo=googlechrome)](https://developer.chrome.com/blog/extensions-in-chrome-116)
[![No Dependencies](https://img.shields.io/badge/dependencies-none-22c55e?style=flat-square)](#)
[![Vanilla JS](https://img.shields.io/badge/stack-Vanilla%20JS-f7df1e?style=flat-square&logo=javascript)]()

</div>

---

## Apa ini?

Form Solver membaca soal dari Google Form yang Anda buka sendiri, meminta AI menjawabnya, lalu **mengisi field-nya satu per satu** ke formulir.

Yang penting dan tidak di（市Lewis): **Form Solver tidak pernah menekan tombol Kirim.** Pengiriman tetap manual, seperti biasa.

Dirancang untuk latihan dan pengujian form milik sendiri — untuk memahami soal, memeriksa kunci jawaban, atau mencoba soal 像URANCEAN pilihan ganda dalam jumlah banyak tanpa mengetik satu per satu.

> Bukan untuk mengisi form milik orang lain, dan bukan untuk mengirim jawaban otomatis. Kalau Anda butuh yang begitu, extension ini bukan alatnya.

---

## Fitur

**Menjawab soal**
- Membaca teks soal, tipe field (dropdown / radio / checkbox / teks), dan semua opsi jawaban
- Mengirim ke AI, lalu memetakan jawaban ke opsi yang benar
- Mengirim soal per satu, bukan satu request berisi 30 soal — context tetap bersih

**Dropdown yang suspend** 
- Membuka menu, menunggu opsi muncul, lalu mengklik yang tepat
- Kalau DOM berubah: fallback ke input tersembunyi + ketik + tekan Enter
- Kalau masih gagal: buka daftar dengan keyboard (`Home` → `↓` → `Enter`)

**Radio & checkbox**
- Memverifikasi hasilnya lewat `aria-checked`, bukan "kelihatan diklik"
- Kalau gagal, diulang sampai 3×

**Jawaban yang benar, bukan yang masuk akal**
Prompt-nya sengaja dibuat sempit, karena model cenderung menjawab "B" padahal yang diminta "nama kota":

| Jenis soal | Yang diminta | Hasil akhir |
|---|---|---|
| Pilihan ganda | Huruf (`B`) | Teks opsi yang persis (`Jakarta`) |
| Isian pendek | Kata yang tepat | Maks. 5 kata; perhitungan hanya angka |

Prefiks `Jawaban:` dari model dibuang otomatis, supaya tidak ikut terisi ke dalam field.

**Gambar soal**
- Otomatis pakai vision kalau modelnya mendukung
- Kalau gagal diunduh, URL-nya dikirim sebagai konteks teks, bukan bikin error
- Teks di dalam gambar (mis. `"Karang Twice"`) ikut dibaca AI, bukan cuma nama file

**Pengaturan**
- API key disimpan di `chrome.storage.local` — tidak pernah ditulis ke kode
- Daftar model diambil langsung dari endpoint model provider, ~137 model, diurutkan: gratis → cepat → mendukung JSON
- Pengaturan `reasoning_effort` per model
- Auto-failover antar beberapa API key: kalau kena `429` atau key dianggap invalid, langsung pindah ke key berikutnya

**Kuota terlihat**
- Badge menampilkan sisa saldo dan jatah token gratis dari endpoint usage, jadi Anda tahu kapan harus berhenti

---

## Cara pakai

**1. Pasang**

```
git clone https://github.com/<username-anda>/form-solver.git
cd form-solver
```

Buka `chrome://extensions` → aktifkan **Developer mode** → **Load unpacked** → pilih folder ini.

**2. Isi API key**

Klik ikon Form Solver di toolbar → buka **Pengaturan** → masukkan API key dari [XKiro](https://xkiro.com). Pilih model, lalu simpan.

Key hanya disimpan lokal di browser Anda dan tidak pernah dikirim ke mana pun selain endpoint provider.

**3. Pakai**

1. Buka form Google yang memang milik Anda
2. Klik ikon extension → widget **AI Form Solver** muncul di bawah judul form
3. Tekan **"Isi Form"** (atau `Ctrl` + `Enter`)
4. Periksa hasilnya, lalu tekan **Kirim** sendiri

> Ganti form? Widget ikut menyesuaikan. Cache tidak disimpan antar-tab, jadi jawaban dari form sebelumnya tidak akan bocor ke form berikutnya.

---

## Cara kerja

```
content.js     → baca DOM Google Form, tulis jawaban ke field
providers.js   → semua urusan AI: request, model, failover, quota
widget.js      → tombol, panel riwayat, panel pengaturan (Shadow DOM)
sw.js          → service worker
widget.css     → styling widget
```

Content script, widget, dan provider jalan sebagai tiga file terpisah yang di-*inject* bersamaan ke halaman.

**Stack:** HTML + CSS + JavaScript vanilla. Tanpa framework, tanpa build step, tanpa dependensi.

Tidak ada kode dari luar yang di-`eval` — semua logika ada di dalam extension, sesuai aturan Manifest V3.

---

## Privasi & izin

Extension ini meminta izin paling sedikit yang mungkin:

| Izin | Untuk apa |
|---|---|
| `activeTab` | Menyembunyikan/menampilkan widget saat tombol diklik |
| `storage` | Menyimpan API key, pilihan model, dan riwayat locally |
| `api.xkiro.com` | Mengirim soal ke AI untuk dijawab |
| `*.googleusercontent.com` | Mengunduh gambar soal untuk dibaca vision model |

**Yang dikirim ke AI:** teks soal, opsi jawaban, dan gambar soal.

**Yang tidak pernah disentuh:** password, cookie, token, dan isi field yang bukan bagian dari form. Tidak ada scraping di luar halaman form, tidak ada telemetri, tidak ada analytics.

Semua riwayat jawaban disimpan lokal dan bisa dihapus kapan saja dari panel.

---

## Batasan yang perlu diketahui

Google mengubah struktur DOM Google Forms dari waktu ke waktu, dan extension ini parses DOM.ahr Versi 3.0.0 sudah menangani perubahan terbaru, tapi tidak ada jaminan selamanya.

Kalau setelah pembaruan Google tombol tidak bisa membaca soal atau mengisi field, ini titik yang perlu disesuaikan di `content.js`:

| Fungsi | Untuk apa |
|---|---|
| `questionTextOf` | Mengambil teks soal |
| `optionLabel` | Mengambil teks opsi jawaban |
| `menuOptionsRaw` | Membaca opsi dari menu dropdown |
| `clickToCheck` / `pressEvents` | Mengklik atau menyetel radio & checkbox |
| `findListbox` | Menemukan elemen daftar dropdown |

Kalau_soal berisi gambar dan model yang dipilih tidak mendukung vision, extension otomatis mundur ke mode teks.

---

## Lisensi

Proyek pribadi untuk belajar. Bebas dibaca, diubah, dan dipakai ulang.

Bukan produk resmi Google — Google Forms dan Chrome adalah milik masing-masing pemiliknya.

**Tidak berafiliasi dengan atau didukung oleh IBM, Code.org, maupun vendor AI mana pun yang disebut di sini.**

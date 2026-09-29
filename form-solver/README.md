# Form Solver

Chrome Extension (Manifest V3) untuk **latihan dan pengujian Google Forms milik sendiri**.
Extension mendeteksi halaman form dan menyuntik **tombol "Isi dengan AI" di bawah judul form**
→ klik = baca soal + jawab + isi otomatis. **Riwayat** di kanan-atas (buka/tutup),
**Pengaturan** di kanan-bawah (key, model, effort, kuota). **Tidak ada auto-submit**
— Submit selalu manual.

Hanya pertanyaan + tipe + pilihan (+ gambar soal bila ada) yang dikirim ke AI
pilihan Anda (**XKiro**).

Teknologi: HTML + CSS + Vanilla JS (content script + Shadow DOM, tanpa framework,
tanpa remote code sesuai aturan MV3). Tanpa Python, tanpa backend tambahan.
Animasi murni CSS (220ms + `prefers-reduced-motion`) — tanpa dependensi eksternal.

```
razor-form-solver/
├── manifest.json
├── content.js     (engine: baca form + klik terverifikasi + deteksi gambar)
├── providers.js   (XKiro, batch paralel, multi-key failover, katalog live)
├── widget.js      (UI dalam halaman: tombol + history + settings)
├── widget.css     (styling Shadow DOM)
├── sw.js          (klik icon toolbar + proxy API bypass CORS)
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

> PENTING: API key JANGAN di-hardcode di file mana pun. Tempel key lewat panel
> Pengaturan di halaman form. Key tersimpan lokal via `chrome.storage.local`
> dan disembunyikan secara default (tombol mata untuk membuka 30 detik).

## 1. Siapkan provider (panel Pengaturan kanan-bawah)

**XKiro (satu-satunya provider):** tombol `Dapatkan API Key` → buat key di dashboard →
tempel (1 per baris, bisa banyak) → **Test XKiro**.
Model **tidak di-hardcode** — Test memuat katalog asli `/v1/models` (137 model) ke
dropdown, diurutkan dari gratis + cepat + bisa JSON + bukan model non-chat.
Badge kuota menampilkan dompet + sisa token gratis dari `/v1/usage`.
**Reasoning effort** diambil dari `reasoning_efforts` yang diumumkan tiap model
(mis. Claude/Gemini hanya `low`/`high`), jadi dropdown sesuai model yang dipilih.

> API key & model OpenRouter sudah dihapus. Data lama (`razor_or_*`) diabaikan;
> hapus entry tersebut dari `chrome.storage.local` bila ingin bersih.

## 2. Load extension

1. Buka `chrome://extensions` → **Developer mode** ON.
2. **Load unpacked** → pilih folder `razor-form-solver` (atau **Reload** bila update).
3. Buka form milik sendiri → tombol **AI Form Solver** muncul di bawah judul.
4. Klik tombol → analisis → jawab → isi otomatis (klik lagi untuk Batal).
5. **Periksa jawaban → Submit manual.**
6. Riwayat tiap run tersimpan (ikon kanan-atas, bisa dibuka/tutup/hapus).

## 3. Yang otomatis

- **Dropdown ListItem:** menu dibuka (klik polos ala console dulu), opsi ditunggu
  via polling, diklik (sequence penuh / polos), fallback hidden-input +
  keyboard ketik + keyboard indeks (Home+Panah+Enter). Menu lain ditutup paksa
  dulu agar tidak menumpuk. Gagal → alasan menyebut tahapnya.
- **Radio/checkbox:** klik diverifikasi via `aria-checked`, diulang hingga 3x.
- **Jawaban selalu inti:** prompt ketat (SALAH `"B"` vs BENAR `"Jakarta"`).
  Huruf jawaban di-snap ke teks opsi persis, prefix `Jawaban:` dibuang, isian
  singkat maks 5 kata (hitungan = angka saja).
- **Kecepatan:** batch isi 6 + paralel 4 jalur, token dibatasi 800, temperatur 0
  (dihilangkan otomatis untuk model reasoning XKiro yang menolaknya).
- **Multi-key auto-failover:** limit (429) / invalid → pindah key berikutnya.
  Test menampilkan "2/3 key OK"; indikator `[key 2/3]` saat berjalan.
- **Gambar:** auto-vision bila model tak support gambar. Gagal unduh → URL
  sebagai konteks teks.
- **Aman ganti form:** tidak ada cache antar-tab yang tercampur (setiap run
  analisis ulang form aktif).

## 4. Permission (minimal)

- `activeTab`, `storage`.
- `host_permissions`: `api.xkiro.com`, `*.googleusercontent.com` (unduh gambar soal).
- `content_scripts` hanya `docs.google.com/forms/*` + `forms.gle/*`.

Tidak mengambil password/cookie/token. Hanya soal + pilihan + gambar soal yang dikirim.

## 5. Troubleshooting

| Gejala | Solusi |
|---|---|
| Tombol tidak muncul | Pastikan URL form responden (`docs.google.com/forms`), reload halaman. Klik icon toolbar untuk toggle. |
| Dropdown "tidak merespons klik" | Lihat alasan di kartu ✗ (tahap: buka-menu / cocok / klik / keyboard). |
| `API key invalid (401/403)` | Key salah / belum aktif. Buat baru via tombol Dapatkan. |
| `Model tidak ada (404)` | Ketik `vendor/nama` persis, atau Test untuk daftar asli. |
| `429 rate-limit` | Untuk model gratis batasnya per key/IP, bukan kode rusak. Tunggu ~1 menit, kurangi soal per jalan (concurrency + jeda otomatis), atau ganti key / model non-free. |
| `402 saldo habis (XKiro)` | Top-up wallet atau pakai model `:free`. |
| `Response AI invalid` | Ulangi. Tidak ada isian sembarangan. |
| Gambar tidak terbaca AI | Pastikan model vision aktif (status auto-vision). |

## 6. Keterbatasan DOM Google Forms

Google mengubah class/DOM sewaktu-waktu. Titik yang perlu disesuaikan di `content.js`:
`questionTextOf`, `optionLabel`, `menuOptionsRaw` (`[role="option"]` + fallback
`[data-value]`), `clickToCheck`/`pressEvents`, `findListbox` (`[role=listbox]` +
`jsname`). Debug via F12 → Elements → cari `role="listitem"` / `role="option"`.

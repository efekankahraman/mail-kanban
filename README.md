# Mail Kanban

Gmail kutunu, iş akışına göre çalışan AI destekli bir kanban board'a çeviren Claude skill'i.

- Takip ettiğin mailler kart olarak düşer; Gemini özetler, önceliklendirir (P1–P5) ve sütunlara dağıtır (Hemen Cevapla, Devam Ediyor, Markada Bekleyen, Bilgi, Otomatik…).
- Takip/hatırlatma, AI cevap taslağı (Gmail'de taslak olarak, asla otomatik gönderilmez), analiz, mobil görünüm.
- İsteğe bağlı **dijital ikiz**: gönderdiğin maillerden üslubunu öğrenir, taslakları senin gibi yazar.
- Her şey kendi Google hesabında çalışır: Apps Script + kendi Google Sheet'in + kendi Gemini API key'in.

## Kurulum (Claude Cowork)

Cowork'te yeni bir görev aç ve şunu yaz:

> https://github.com/efekankahraman/mail-kanban adresindeki SKILL.md'yi oku ve bu skill'i bana kaydet. Sonra mail kanban'ımı kur.

Claude skill'i kaydetmen için bir kart gösterir (tek tık), ardından birkaç soruyla iş akışını öğrenir ve kurulumu `clasp` ile kendisi yapar. Senden istenen yalnızca:

1. Apps Script API'yi açmak (script.google.com/home/usersettings, tek tık)
2. Google girişine izin vermek ve dönen linki sohbete yapıştırmak
3. Board linkini açıp Google izinlerini onaylamak
4. Gemini API key'ini (aistudio.google.com/apikey) kurulum sayfasına yapıştırmak

**Ön koşul:** Claude'un ağ ayarlarında `*.googleapis.com` izinli olmalı (Settings → Capabilities; ekip planında org sahibi ayarlar). Değilse Claude söyler.

## İçerik

| Dosya | Ne işe yarar |
|---|---|
| `SKILL.md` | Claude'un izlediği kurulum talimatı |
| `assets/Code.gs` | Backend (kişiselleştirme sadece en üstteki `PERSONAL` bloğunda) |
| `assets/Setup.gs` | Otomatik kurulum ve ilk açılış sayfası |
| `assets/Board.html` | Board arayüzü |
| `assets/Style.gs` | Elle yazı avatarı (normalde boş) |
| `assets/appsscript.json` | Manifest |
| `scripts/clasp-auth.mjs` | clasp girişi (iki adım) |
| `references/` | Örnek iş akışı, geliştirme notları, elle kurulum rehberi |

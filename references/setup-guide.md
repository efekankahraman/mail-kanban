# Mail Board: Kurulum (~10 dk)

Tüm adımları **iş mail hesabınla** oturum açıkken yap.

## 1. Sheet ve Apps Script
1. Yeni bir Google Sheet aç ve adını **Mail Board** koy.
2. Menüden **Uzantılar → Apps Script**'i aç.
3. `Code.gs` içeriğini editördeki `Code.gs` dosyasına yapıştır. İçerikteki her şeyi değiştir.
4. Sol tarafta **+ → HTML**'e tıkla, dosyanın adını `Board` koy ve `Board.html` içeriğini yapıştır.
5. **Proje Ayarları (⚙)** → "appsscript.json dosyasını düzenleyicide göster" kutusunu işaretle. Sonra `appsscript.json` içeriğini yapıştır.
6. Kaydet (💾) ve Sheet sekmesini yenile. Üstte **📋 Mail Board** menüsü çıkar.

## 2. Ayarlar
1. **📋 Mail Board → 1) Kurulumu başlat** → izin ekranında erişimleri onayla.
2. **Ayarlar** ve **ClientManagers** (ekip) sayfaları senin bilgilerinle hazır gelir. Kontrol et.
3. https://aistudio.google.com/apikey adresinden bir API key al. Yoğun kullanımda faturalandırmayı aç.
4. **📋 Mail Board → 2) Gemini API key gir**.

## 3. Çalıştır
1. **📋 Mail Board → Şimdi tara**. Log sayfasında "Tarama: … işlendi" satırını gör.
2. **📋 Mail Board → 3) Otomatik taramayı aç**. Tarama bundan sonra her 10 dakikada bir çalışır. Geçmişteki okunmamış mailler de arka planda aktarılır.

## 3b. (İsteğe bağlı) Dijital ikiz
**📋 Mail Board → Dijital ikiz (yazı avatarı) oluştur / güncelle**. Gönderdiğin maillerden üslubun çıkarılır ve **Yazı Avatarı** sayfasına yazılır. Cevap taslakları bundan sonra senin gibi yazılır. İstediğin zaman düzenleyebilir, silebilir ya da yeniden oluşturabilirsin.

## 4. Board'u aç
1. Apps Script'e dön: **Deploy → New deployment → Web app**.
2. *Execute as:* **Me**, *Who has access:* **Only myself** → Deploy.
3. Çıkan linki yer imine ekle. Board bu.

Kodu güncellersen: **Deploy → Manage deployments → Edit → New version**.

## Bilmen gereken en önemli kural
- Takip etmek istediğin mailler Gmail'de **okunmamış** kalmalı. Gmail'de bir maili okumak = o işi kapatmak (kart Done'a gider). Bunu istemiyorsan Ayarlar'da `READ_CLOSES` = HAYIR yap; o zaman kartlar sadece board'dan kapanır.
- Mailleri board'dan okumak maili okundu yapmaz.

## Kullanım ipuçları
- **Kartı taşıma:** Kartları sürükleyerek taşı. Tamamlandı'ya ya da Done'a bırakınca Gmail label'ı kalkar ve mail okundu olur.
- **Kart detayı:** Karta tıklayınca özet, konuşmanın tamamı, Gmail linki ve cevap taslağı açılır. ← → tuşlarıyla aynı kolondaki diğer kartlara geçersin.
- **Toplu işlem:** Cmd/Ctrl + tık ile çoklu seçim yap. Alttaki çubuktan toplu taşıma ve toplu hatırlatma yapabilirsin.
- **Sütun sırası:** Sütunları başlığından (⋮⋮) sürükleyerek sıralayabilirsin.
- **Yanlış sınıflama:** Yanlış sınıflanan bir mail görürsen Claude'a göster, birlikte ayarlarız.

---
name: mail-kanban
description: Kişinin Gmail (Google Workspace) kutusundan, iş akışına göre çalışan AI destekli bir kanban board kurar. Kurulumu clasp ile otomatik yapar; kullanıcı Sheet açmaz, kod kopyalamaz. "Mail kanban kur", "maillerimi kanban'a dök", "mail takip board'u", "gmail kanban" gibi isteklerde kullan.
---

# Mail Kanban kurulum skill'i

Bu skill, kullanıcının Gmail'ine bağlı çalışan bir **mail takip kanban board'u** kurar. Board Google Apps Script üzerinde çalışır, sınıflandırmayı Gemini API yapar, veriler kullanıcının kendi Google Sheet'inde tutulur.

**Kurulum tamamen otomatiktir:** Claude dosyaları GitHub'dan indirir, kişiselleştirir, `clasp` ile kullanıcının Google hesabında Sheet + Apps Script projesini oluşturur, kodu yükler ve web app olarak yayınlar. Kullanıcı Sheet açmaz, Apps Script editörüne girmez, kod kopyalamaz. Kullanıcıya kalan yalnızca Google'ın bizzat ondan istediği onaylardır (aşağıda 4 tıklama).

Dosyaların kaynağı (her kurulumda buradan indir, kopyası skill'de durmaz):

```
REPO=https://raw.githubusercontent.com/efekankahraman/mail-kanban/main
$REPO/assets/Code.gs          # backend; kişiselleştirme SADECE en üstteki PERSONAL bloğunda
$REPO/assets/Setup.gs         # otomatik kurulum: ilk açılışta Gemini key sayfası, tetikleyiciler, ilk tarama
$REPO/assets/Style.gs         # elle konan yazı avatarı (normalde boş)
$REPO/assets/Board.html       # board arayüzü
$REPO/assets/appsscript.json  # manifest (Gmail Advanced Service + web app ayarı)
$REPO/scripts/clasp-auth.mjs  # clasp girişi, iki adımda (uzun süre açık terminal gerekmez)
$REPO/references/example-workflow.md   # kullanıcıya gösterilecek örnek iş akışı
$REPO/references/lessons.md            # kodu değiştirmeden ÖNCE oku
$REPO/references/setup-guide.md        # yalnızca otomatik kurulum imkânsızsa: elle kurulum
```

Kullanıcıların çoğu teknik değil. Amaç, **10 dakikada**, kod okumadan ve kopyala-yapıştır yapmadan kurulum.

## Akış

### 1. Kısa tanıtım ve örnek iş akışı
Önce ne kurulacağını 3–4 cümleyle anlat:
- Gmail'deki takip edilen mailler board'a kart olarak düşer, AI özetler ve sütunlara (Hemen Cevapla, Bekleyen, Markada Bekleyen…) dağıtır.
- Takip ve hatırlatma, AI ile cevap taslağı, analiz sayfası, Yapılacaklar sütunu, mobil kullanım var.
- **İsteğe bağlı dijital ikiz:** Kullanıcının gönderdiği maillerden üslubu öğrenilir, cevap taslakları onun gibi yazılır.

Sonra `references/example-workflow.md`'yi indirip **örnek iş akışını** kısaltarak göster; kullanıcı kendi akışını anlatırken neyi tarif etmesi gerektiğini anlar.

### 2. Kullanıcının iş akışını sor (ZORUNLU, kod üretmeden önce)
Herkesin iş akışı farklı. Varsayımla ilerleme. AskUserQuestion ile (seçenek + "Other" serbest metin) şunları topla. Birbirine bağlı olanları tek turda 3–4 soru olarak grupla:

1. **Rolü ve iş akışı:** Ne iş yapıyor, mailler ona nasıl geliyor, işi kim yapıyor? Kullanıcıdan 2–4 cümlelik serbest anlatım iste, örnek akışı referans göster.
   Tipik kalıplar:
   - (a) Ekibini takip eden yönetici (Client Director → CM'ler).
   - (b) İşi kendisi yürüten kişi (CM / Account Manager → markalar + iç ekipler).
   - (c) Destek/operasyon (talepler → çözüm).
2. **Takip ettiği ekip:** Varsa ekip üyelerinin adı, maili, sorumlu olduğu markalar/işler ve markaların mail domainleri. Ekip yoksa bu kısım boş kalır. Ekiple ilgili kolonlar (STALE, REMINDED, WAITING_CM) ya gizlenir ya da "iç ekip / operasyon" anlamında yeniden adlandırılır.
3. **"Bana direkt" tanımı:** Hangi mailler hemen cevap bekler (To'da sadece o, ismiyle hitap, onay talebi…) ve hitap şekilleri (ör. "Ayşe", "Ayşe Hanım").
4. **Öncelikler (P1–P5):** Varsayılanı göster (`PERSONAL.PRIORITY_RULES`), değiştirmek isteyip istemediğini sor.
5. **Kolonlar:** Varsayılan kolonları göster. Gizlemek ya da adını değiştirmek istediği var mı? Kolon kodları: MY_REPLY, STALE, REMINDED, WAITING_CM, IN_PROGRESS, WAITING_CLIENT, JIRA, COMPLETED, FYI, INTERNAL, AUTO, DONE.
6. **Takip süreleri:** Kaç iş günü hareketsiz kalınca "bekleyen" sayılsın (varsayılan 3)? Hatırlatmadan sonra kaç iş günü beklensin (varsayılan 2)? Hatırlatma metni ne olsun (varsayılan "burada bir gelişme var mı")?
7. **Yok sayılacaklar:** Artık bakmadığı marka/konu var mı? Bunlara ait mailler, kullanıcıya direkt değilse okundu yapılır ve board'a gelmez.
8. **Cevap taslağı üslubu:** Açılış, kapanış ve ton. Varsayılan: "Selamlar, … Sevgiler,", ne çok resmi ne çok samimi, karşı taraf "Bey/Hanım" demediyse kullanma. Gmail imzası otomatik eklenir.
9. **Şirket bilgisi:** Şirket adı, şirket domaini, imzadaki adres parçaları. Adres parçaları marka sanılmasın diye sorulur; örnek vakada imzadaki bir semt adı markayla karıştı.
10. **Jira/Asana vb.:** Kullanıyorsa bildirim adresinin parçası (ör. `atlassian.net`, `asana.com`).

11. **Gmail'i nasıl yönetiyor? (ÇOK ÖNEMLİ, mutlaka sor ve anlat)** Board'un standart çalışma şekli şudur, kullanıcıya açıkça söyle:
    - Board, takip edilen her işin Gmail'de **okunmamış** durduğunu varsayar. Okunmamış = açık iş, kart board'da kalır.
    - Bir maili Gmail'de **okumak** = o işi kapatmak demektir; kart Done'a gider ve Gmail label'ı kalkar.
    - Board'da kartı Done'a almak maili Gmail'de okundu yapar. Thread'e yeni mesaj gelirse kart kendiliğinden geri açılır.
    - Bu yüzden takip etmek istediği mailleri Gmail'de açıp okuyorsa ya "okunmadı olarak işaretle" alışkanlığı edinmeli ya da mailleri board'dan okumalı (kart penceresinde konuşmanın tamamı görünür, maili okundu yapmaz).
    Sonra sor: "Gmail'de mailleri okuyup kutuda bırakıyor musun, yoksa okunmamış tutup sırayla mı kapatıyorsun?" Kullanıcı standarda uymak istemiyorsa birlikte karar verin: `READ_CLOSES: 'HAYIR'` → Gmail'de okumak kartı kapatmaz, kartlar sadece board'dan Done'a alınınca kapanır (geçmiş aktarımı yine sadece okunmamışları çeker). Seçimi `PERSONAL`'a yaz ve neyi seçtiğini tek cümleyle teyit et.
12. **Dijital ikiz (opsiyonel):** Özelliği tek cümleyle anlat ve sor: "Şimdi kuralım / Sonra / İstemiyorum". Kurulumda seçerse board'un ilk açılış sayfasındaki "Dijital ikiz" kutusu işaretli bırakılır, ilk taramadan sonra kendiliğinden oluşur. "Sonra" ya da "İstemiyorum" derse sistem genel üslupla taslak yazmaya devam eder; menüden istediği zaman açabileceğini söyle.

Kullanıcı bir şeyi bilmiyorsa varsayılanı kullan ve bunu açıkça söyle.


### 3. Ortamı hazırla ve dosyaları kişiselleştir

**3a. Hangi kabukta çalışacağına karar ver.** clasp'in Google API'lerine erişmesi gerekir.
- Kullanıcının bilgisayarına bağlı kabuk (`mcp__remote-devices__device_bash`) varsa onu kullan; yoksa bulut kabuğunu (`Bash`).
- Erişimi test et: `curl -s -o /dev/null -w '%{http_code}' -m 10 https://script.googleapis.com/` → `000` dışında bir kod (404 dahil) = erişim var.
- İki kabukta da `000` ise ağ izni kapalıdır. Kullanıcıya tek mesajla söyle: Claude ayarlarında (Settings → Capabilities, ekip planında org sahibi Admin settings → Capabilities) izin verilen domainlere `*.googleapis.com` eklesin (ya da tek tek: `script.googleapis.com, oauth2.googleapis.com, www.googleapis.com, sheets.googleapis.com, drive.googleapis.com`), sonra **yeni bir görev** başlatıp tekrar "mail kanban kur" desin. Bu sırada sorulara verdiği cevapları yeni göreve yapıştırması için `PERSONAL` bloğunu ona ver. Kullanıcı ayar değiştiremiyorsa son çare `references/setup-guide.md` (elle kurulum).

**3b. Çalışma klasörü.** Bağlı bir klasör varsa onun içinde `Mail Board/` oluştur (`.clasp.json` ve deployment ID orada kalır, sonraki güncellemeler için gerekli). Yoksa kabuğun ev dizininde `mail-board/`.

**3c. clasp'i kur:** `npm i --prefix ~/clasp @google/clasp@3` (global kurulum gerekmez; komut `~/clasp/node_modules/.bin/clasp`). `clasp-auth.mjs`'i `curl -fsSL $REPO/scripts/clasp-auth.mjs -o ~/clasp-auth.mjs` ile indir.

**3d. Kişiselleştir (dosyalar 4. adımda, `clasp create`'ten SONRA indirilir; create kendi manifestini yazar).** 2. adımdaki cevaplardan `PERSONAL` bloğunu hazırla:
- `WORKFLOW`: kullanıcının iş akışı, birinci ağızdan, net ve somut 3–6 cümle. Mutlaka: kim iş verir, işi kim yürütür, kullanıcıdan ne beklenir, "tamamlandı" ne demek.
- Ekip yoksa `TEAM: []`, `TEAM_ROLE` = iç ekiplerin adı (ör. "Operasyon ekibi"), gerekirse `HIDDEN_COLUMNS: 'STALE, REMINDED'`.
- Kolon adları `COLUMN_NAMES` ile: `"WAITING_CM=Operasyon Cevabı Bekleniyor; JIRA=Asana"`.
- `MY_EMAIL` ve `INTERNAL_DOMAINS` boş kalabilir; ilk kurulumda giriş yapan hesaptan doldurulur.
- Kodun geri kalanına dokunma. Değiştirmek gerekiyorsa önce `references/lessons.md`'yi oku.
- Bloğu dosyaya python ile yaz (`var PERSONAL = {` … `// >>> KİŞİSELLEŞTİRME SONU <<<` arasını değiştir), elle yeniden yazma. Sonra `node -e` ile tüm .gs dosyalarını birleştirip `new Function(...)` ile sözdizimini kontrol et.

### 4. Otomatik kurulum (clasp)

Her kullanıcı adımını tek tek iste, cevabını bekle. Link ve talimatları `SendUserMessage` ile gönder.

**4a. Kullanıcı: Apps Script API'yi aç (tek seferlik).** https://script.google.com/home/usersettings → "Google Apps Script API" → **Açık**. Board hangi Google hesabında kurulacaksa o hesapla.

**4b. Kullanıcı: clasp girişi.**
1. `node ~/clasp-auth.mjs url` → çıkan linki kullanıcıya gönder (CLASP_DIR varsayılanı `~/clasp`).
2. Kullanıcı linki açar, **board'un kurulacağı hesabı** seçer, izin verir. Tarayıcı "bu siteye ulaşılamıyor" diyen bir sayfaya gider; bu normaldir. Adres çubuğundaki `http://localhost:8888/?...code=...` linkinin tamamını sohbete yapıştırır.
3. `node ~/clasp-auth.mjs code '<yapıştırılan link>'` → "clasp girişi tamam". Kod ~10 dk geçerli ve tek kullanımlıktır; hata alırsan 1. adımı yeni linkle tekrarla.
4. `clasp show-authorized-user` ile doğrula.

**4c. Claude: Sheet + proje oluştur, yükle, yayınla** (çalışma klasöründe):
```bash
C=~/clasp/node_modules/.bin/clasp
$C create --type sheets --title "Mail Board" --json      # Sheet + bağlı script; çıktıdan scriptId ve Sheet ID/URL'sini al
for f in Code.gs Setup.gs Style.gs Board.html appsscript.json; do curl -fsSL "$REPO/assets/$f" -o "$f"; done
# Code.gs'e PERSONAL bloğunu yaz (3d), sözdizimini kontrol et
sed -i "s/^var BOOT_SPREADSHEET_ID = '';/var BOOT_SPREADSHEET_ID = '<SHEET_ID>';/" Setup.gs
printf '**/*.md\nscripts/**\nnode_modules/**\n' > .claspignore
$C push --force                                          # manifest dahil her şeyi yükler
$C create-deployment --description "Mail Board" --json   # deploymentId
```
- Sheet ID `create` çıktısında yoksa `https://docs.google.com/spreadsheets/d/<ID>` linkinden ya da `.clasp.json`'daki `parentId`'den al.
- Board linki: `https://script.google.com/macros/s/<deploymentId>/exec`. deploymentId'yi çalışma klasöründe `deployment.txt`'ye yaz.
- `push` "User has not enabled the Apps Script API" derse 4a yapılmamıştır; yaptırıp birkaç dakika bekleyip tekrar dene.

**4d. Kullanıcı: board'u ilk kez aç.** Board linkini gönder ve şunu söyle:
1. Google "Yetkilendirme gerekli" der → **İzinleri incele** → hesabını seç. "Google bu uygulamayı doğrulamadı" uyarısı çıkarsa **Gelişmiş → Mail Board'a git (güvenli değil)** → **İzin ver**. Uygulama kendi hesabında, kendi yazdığı kod gibi çalışır; uyarı bu yüzden çıkar.
2. Açılan "Mail Board kurulumu" sayfasında https://aistudio.google.com/apikey adresinden aldığı **Gemini API key**'i yapıştırır. Dijital ikiz istemiyorsa kutunun işaretini kaldırır. **Kurulumu tamamla**.
3. Sayfa board'a geçer. İlk tarama ~1 dk içinde başlar, kartlar birkaç dakikada dolar; geçmişteki okunmamış mailler arka planda aktarılır. Dijital ikiz seçildiyse ~1 dk sonra "Yazı Avatarı" sayfası oluşur.

Kurulum sayfası arka planda şunları yapar (Setup.gs → `completeSetup`): Ayarlar/ClientManagers/Tasks/Log sayfalarını oluşturur, Gmail label'larını açar, key'i kaydeder, 10 dakikalık taramayı ve geçmiş aktarımını kurar, ilk taramayı ve (seçildiyse) dijital ikizi tek seferlik tetikleyicilerle başlatır.

**4e. Kontrol.** Birkaç dakika sonra kullanıcıdan board'a bakmasını iste. Kart gelmediyse Sheet'teki **Log** sayfasına baktır (Sheet linkini sen ver). Faturalandırma açık değilse Gemini'nin ücretsiz kotası kısa sürede dolar; board kırmızı uyarı gösterir.

### 4b-eğitim. Kritik noktaları anlat (kurulum bitince kısa özet)
- `READ_CLOSES = EVET` ise: takip edilen mail Gmail'de **okunmamış** kalır; okumak = Done. Okuyup takipte tutmak istediği maili "okunmadı" yapmalı ya da "Yakın Takip" sütununa almalı. `HAYIR` ise kartlar sadece board'dan kapanır.
- Kartı Done'a almak Gmail'de okundu yapar; yeni mesaj gelince kart geri gelir.
- "Daha Sonra Bak" ve "Yakın Takip" elle kullanılan sütunlardır.
- Cevap taslağı otomatik sadece Hemen Cevapla kartlarında yazılır; diğerlerinde "✨ AI ile cevap" butonu var. Taslak asla gönderilmez, Gmail'de taslak olarak oluşur.
- Sheet'teki "📋 Mail Board" menüsü ileri ayarlar içindir (yeniden sınıflama, dijital ikizi güncelleme…); günlük kullanımda gerekmez.
- Yanlış sınıflanan kartı Claude'a göstermesini söyle; ayarla düzeltilir.

### 5. Güncelleme ve ince ayar
- Ayar değişikliği (WORKFLOW, öncelikler, ekip, IGNORE_BRANDS, ADDRESS_HINTS…) Sheet'teki **Ayarlar** sayfasından yapılır; kod yüklemeye gerek yok. Sonra menüden "Açık kartları yeniden sınıfla" ya da "CM atamalarını yeniden hesapla".
- Kod değişikliği / yeni sürüm: çalışma klasöründe dosyaları `$REPO`'dan yeniden indir (PERSONAL bloğunu koru), `clasp push --force`, sonra `clasp create-deployment -i <deploymentId>` (aynı link kalır). Çalışma klasörü kaybolduysa `clasp list` ile "Mail Board" projesini bul, `clasp clone <scriptId>` ile geri al.
- Yanlış sınıflanmış mail: tahmin etme. Tasks satırındaki `flags`, `priorityReason`, `lastSenderRole` ve Log sayfasına bak. Önce ayarla çözmeyi dene, ancak gerekiyorsa kodu değiştir (önce `references/lessons.md`).

## Kritik kurallar
Ayrıntılar `references/lessons.md`'de. Bunları bozacak değişiklik yapma:
- Google Group / şirket içi listeler newsletter DEĞİLDİR (List-Id ve Precedence: list başlıkları yanıltır).
- Marka, mail gövdesinde isim aranarak bulunmaz; imzadaki adresler yanıltır. Sıra: domain → AI markası → maile ekli ekip üyesi.
- Ekip üyesi maile ekli değilse iş ona atanmaz.
- Geniş dağıtım alıcı sayısıyla değil, liste sinyali ve içerikle belirlenir.
- Aynı mail tekrar okunmaz: thread hafızası (`memory`) ve önbellek (`factsCache`).
- Geçmiş aktarımı yalnızca okunmamışları çeker.
- Board işlemleri arka plan kilidini beklemez.
- AI çalışmazsa mail yine board'a düşer ("AI bekliyor" rozetiyle).
- Kullanıcının Gemini key'ini, clasp token'ını ya da `~/.clasprc.json`'ı sohbete, dosyalara ya da başka bir yere yazma; key yalnızca kurulum sayfasına girilir.

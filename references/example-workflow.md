# Örnek iş akışı: Client Director

Bu, board'un ilk kurulduğu gerçek kullanım. Kullanıcıya "kendi akışını buna benzer şekilde anlat" diye göstermek için.

**Rol:** Client Director. Kendisine bağlı 4 Client Manager (CM) var.

**Akış:**
- Markalar (müşteriler) işleri CM'lere mail atar. CM'ler Jira'da iç ekiplere (performans, kreatif, data) task açar ve işi yürütür.
- Client Director mailleri takip eder. İşlerin doğru ve eksiksiz yapılıp yapılmadığını, kalan iş olup olmadığını kontrol eder ve kendisine gelen taleplere hızlı döner.
- Aynı thread'de bir iş kapanıp yenisi açılabilir. Özet sadece güncel işi anlatmalı.

**Öncelikler:**
1. Direkt bana (To'da sadece ben, ya da isimle hitap + benden aksiyon; "herkes doldursun" gibi talepler de dahil)
2. Büyük brief (sunum, strateji, yıllık plan) + takvim davetleri
3. Standart kurulum/plan (sadece ne olup bittiğini görmem yeterli)
4. Geniş kitleye duyurular (İK, ofis)
5. Newsletter / otomatik

**Kolonlar ve anlamları:**
- Hemen Cevapla
- 3+ İş Günü Bekleyen: CM'e hatırlat.
- Hatırlatma Yapıldı: 2 iş günü dönüş olmazsa geri düşer.
- CM Cevabı Bekleniyor
- Devam Ediyor
- Markada Bekleyen: Biz son sözü söyledik, dönüş markadan bekleniyor.
- Jira
- İş Tamamlandı
- Bilgi · Takip: Takip edilecek ama bana sorulmayan işler.
- Internal
- Otomatik
- Done: Okundu.

**Özel kurallar:**
- Artık bakılmayan bir marka varsa, o markanın bana direkt olmayan mailleri otomatik okundu yapılır.
- CM son mailinde "yapıyor olacağız" deyip 3+ iş günü sessiz kaldıysa iş tamamlanmış sayılır, hatırlatma gerekmez.
- Hatırlatma maili sadece ilgili CM'e, thread içinde gider. Metin birebir: "burada bir gelişme var mı".
- Cevap taslakları "Selamlar, … Sevgiler," yapısında, Gmail imzasıyla. Karşı taraf "Bey" demediyse Bey/Hanım kullanılmaz.

**Başka rollere uyarlama örnekleri:**
- **Account/Client Manager (işi kendisi yürütür):**
  - Ekip listesi yerine iç ekipler (operasyon, kreatif) yazılır ya da boş bırakılır.
  - "CM Cevabı Bekleniyor" → "Operasyon Cevabı Bekleniyor" diye adlandırılabilir.
  - "Hemen Cevapla" markalardan gelen taleplerdir.
- **Tek başına çalışan uzman:**
  - STALE ve REMINDED gizlenir.
  - Board'da Hemen Cevapla / Markada Bekleyen / Devam Ediyor / Bilgi / Otomatik yeterli olur.

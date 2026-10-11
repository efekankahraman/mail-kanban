/**
 * ============================================================
 *  MAIL KANBAN — kişiye özel Gmail iş takip board'u (şablon)
 *  Bu dosya "mail-kanban" skill'i ile kullanıcının iş akışına göre doldurulur:
 *  sadece aşağıdaki >>> KİŞİSELLEŞTİRME <<< bloğunu değiştirmek yeterlidir.
 *  Google Apps Script + Gmail + Gemini API
 * ============================================================
 *  - Okunmamış mailleri tarar, tüm thread'i okuyup Gemini ile sınıflar
 *  - Öncelik (P1–P5), sorumlu Client Manager ve iş durumunu belirler
 *  - Gmail'de "Board/..." label'larını atar / kaldırır
 *  - Web app olarak drag & drop kanban board sunar
 *
 *  v2 — Google Groups listeleri artık newsletter sayılmıyor, Jira kolonu,
 *       3+ iş günü bekleyenler + CM hatırlatması, yok sayılan markalar,
 *       imza/adres metninden marka eşleştirme hatası giderildi.
 *
 *  Kurulum için KURULUM.md dosyasına bak.
 */

// ---------- SABİTLER ----------
var SHEET_TASKS = 'Tasks';
var SHEET_SETTINGS = 'Ayarlar';
var SHEET_CMS = 'ClientManagers';
var SHEET_LOG = 'Log';
var SHEET_TODOS = 'Todos';
var SHEET_JIRA = 'JiraProjeleri';   // marka → Jira projesi eşleştirmesi (elle düzenlenebilir; board'dan seçince güncellenir)
var SHEET_SEEN = 'Seen';     // panoda açıp gördüğün kartlar: threadId → o an gördüğün son mesaj

var LABEL_ROOT = 'Board';
var PRIORITY_LABELS = {
  1: 'Board/1 - Bana Direkt',
  2: 'Board/2 - Büyük Brief & Davet',
  3: 'Board/3 - Kurulum & Plan',
  4: 'Board/4 - Geniş Dağıtım',
  5: 'Board/5 - Otomatik & Bilgi'
};
var JIRA_LABEL = 'Board/Jira';
// Gmail'de görünen durum label'ları (Gmail aramasında: label:board-hemen-cevapla, label:board-yakin-takip)
var STATUS_LABELS = { MY_REPLY: 'Board/Hemen Cevapla', WATCH: 'Board/Yakin Takip', ACTION: 'Board/Islem Gerekiyor' };
var PRIORITY_NAMES = {
  1: 'Bana Direkt',
  2: 'Büyük Brief / Davet',
  3: 'Kurulum & Plan',
  4: 'Geniş Dağıtım',
  5: 'Otomatik / Bilgi'
};

// Kanban kolonları (sıra = board'daki sıra)
var STATUSES = ['MY_REPLY', 'WATCH', 'STALE', 'CLIENT_STALE', 'LATER', 'REMINDED', 'WAITING_CM', 'ACTION', 'IN_PROGRESS', 'WAITING_CLIENT', 'JIRA', 'JIRA_WIP', 'JIRA_DONE', 'COMPLETED', 'FYI', 'INTERNAL', 'AUTO', 'DONE'];
function isJiraStatus_(s) { return /^JIRA(_WIP|_DONE)?$/.test(String(s || '')); }
var STATUS_NAMES = {
  MY_REPLY: 'Hemen Cevapla',
  WATCH: 'Yakın Takip',
  STALE: '3+ İş Günü Bekleyen',
  CLIENT_STALE: 'Markada 5+ İş Günü',
  LATER: 'Daha Sonra Bak',
  REMINDED: 'Hatırlatma Yapıldı',
  WAITING_CM: 'CM Cevabı Bekleniyor',
  ACTION: 'Cevaplandı · İşlem Gerekiyor',
  IN_PROGRESS: 'Cevaplandı · İş Devam Ediyor',
  WAITING_CLIENT: 'Markada Bekleyen',
  JIRA: 'Jira · Alınmayı Bekliyor',
  JIRA_WIP: 'Jira · Ekip Yapıyor',
  JIRA_DONE: 'Jira · Ekip Tamamladı',
  COMPLETED: 'İş Tamamlandı',
  FYI: 'Bilgi · Takip',
  INTERNAL: 'Internal · Geniş Dağıtım',
  AUTO: 'Otomatik · Newsletter',
  DONE: 'Done · Okundu'
};
var CLOSED_STATUSES = ['COMPLETED', 'DONE'];
// Elle yönetilen sütunlar: kart buraya sadece kullanıcı taşır; okunsa da, yeni mesaj gelse de o çıkarana kadar kalır
var STICKY_STATUSES = ['WATCH', 'ACTION'];
function isSticky_(s) { return STICKY_STATUSES.indexOf(String(s || '')) >= 0; }
var STALE_SOURCE = ['WAITING_CM', 'IN_PROGRESS'];

var COLS = [
  'threadId', 'subject', 'title', 'brand', 'cm', 'cmEmail',
  'priority', 'priorityReason', 'status', 'aiStatus', 'manualStatus',
  'closed', 'closedAt', 'closedBy',
  'summary', 'clientAsk', 'cmResponse', 'nextAction', 'suggestedReply',
  'participants', 'lastSender', 'lastSenderRole', 'firstDate', 'lastDate',
  'msgCount', 'lastMsgId', 'addressedToMe', 'flags', 'link', 'updatedAt',
  'remindedAt', 'hasCm', 'memory', 'factsCache', 'followUp', 'recentMine'
];

// >>> KİŞİSELLEŞTİRME — skill bu bloğu kullanıcının cevaplarına göre doldurur <<<
var PERSONAL = {
  MY_EMAIL: '',                          // boş kalırsa kurulumda oturum açan hesap kullanılır
  MY_NAME: '',                           // Ad Soyad
  MY_NAME_ALIASES: '',                   // "Ayşe, Ayşe Hanım" gibi hitaplar
  COMPANY_NAME: 'Şirket',                // AI'a "biz" tarafını anlatmak için (ör. BIZ)
  INTERNAL_DOMAINS: '',                  // şirket domain(ler)i; boşsa MY_EMAIL'den alınır
  MY_ROLE: 'Client Director',            // kullanıcının unvanı/rolü
  TEAM_ROLE: 'Client Manager',           // takip ettiği ekip üyelerinin rolü (yoksa boş)
  TEAM_SHORT: 'CM',                      // kartlarda/kolonlarda kısa ad
  WORKFLOW: 'Ekibimdeki Client Managerlar markalardan gelen işleri alır, Jira\'da iç ekiplere task açar. Ben mailleri takip eder, işlerin doğru ve eksiksiz yapıldığını kontrol eder, bana gelen taleplere hızlı dönerim.',
  PRIORITY_RULES: '1 = Doğrudan bana hitap eden ya da benden aksiyon isteyen gerçek iş maili.\n2 = Bana hitap edilmese de büyük çaplı brief: büyük sunum, strateji, yıllık plan, pitch, bütçe planlaması, yeni proje, kriz. Takvim davetleri de 2.\n3 = Standart kurulum, kampanya/medya planı, yayına alma, optimizasyon, rutin rapor.\n4 = İş dışı genel duyurular (İK, ofis, etkinlik).\n5 = Newsletter, otomatik bildirim, sistem maili.',
  ADDRESS_HINTS: '',                     // şirket imzasındaki adres parçaları (marka sanılmasın), virgülle
  IGNORE_BRANDS: '',                     // artık bakılmayan marka/kişiler, virgülle
  HIDDEN_COLUMNS: '',                    // gizlenecek kolon kodları, virgülle (ör. STALE, REMINDED, JIRA)
  COLUMN_NAMES: '',                      // kolon adlarını değiştir: "WAITING_CM=Ekip Cevabı Bekleniyor; JIRA=Asana"
  JIRA_PATTERNS: 'atlassian.net, jira@',
  JIRA_SITE: '',                         // Board'dan task açmak için Jira adresi, ör. https://firma.atlassian.net
  JIRA_TEAM_LABELS: '',                  // ör. 'SM=Sosyal_Medya, Google=Google_Ads'
  STALE_BUSINESS_DAYS: '3',
  REMIND_WAIT_BUSINESS_DAYS: '2',
  REMINDER_TEXT: 'burada bir gelişme var mı',
  FILTER_BY: 'KISI',                    // Board filtresi: KISI (ekip üyelerine göre) | MARKA (markalara göre; account manager'lar için)
  BRANDS: '',                           // MARKA filtresi için: "Marka=domain.com,domain2.com; Marka2=marka2.com" (domain eşleşen mail o markaya yazılır)
  READ_CLOSES: 'EVET',                  // Gmail'de okunan mail board'da Done olsun mu? (standart: EVET — takip edilen her şey Gmail'de okunmamış durur)
  REPLY_OPENING: 'Selamlar,',
  REPLY_CLOSING: 'Sevgiler,',
  REPLY_TONE: 'Ne çok samimi ne çok resmi; net, kısa, profesyonel ama sıcak. Karşı taraf bana "Bey/Hanım" diye hitap etmediyse "Bey/Hanım" kullanma.',
  TEAM: [                                // [Ad Soyad, email, markalar (virgülle), marka domainleri (virgülle)]
    ['Ekip Üyesi 1', 'uye1@sirket.com', 'Marka A, Marka B', 'markaa.com'],
    ['Ekip Üyesi 2', 'uye2@sirket.com', 'Marka C', '']
  ]
};
// >>> KİŞİSELLEŞTİRME SONU <<<

var DEFAULT_SETTINGS = [
  ['MY_EMAIL', PERSONAL.MY_EMAIL, 'Board sahibinin mail adresi'],
  ['MY_NAME', PERSONAL.MY_NAME, 'Ad soyad (AI hitap tespiti için)'],
  ['MY_NAME_ALIASES', PERSONAL.MY_NAME_ALIASES, 'Sana hitap şekilleri (virgülle)'],
  ['COMPANY_NAME', PERSONAL.COMPANY_NAME, 'Şirket adı (AI için "biz" tarafı)'],
  ['INTERNAL_DOMAINS', PERSONAL.INTERNAL_DOMAINS, 'Şirket içi domain(ler), virgülle'],
  ['MY_ROLE', PERSONAL.MY_ROLE, 'Senin rolün'],
  ['TEAM_ROLE', PERSONAL.TEAM_ROLE, 'Takip ettiğin ekip üyelerinin rolü'],
  ['TEAM_SHORT', PERSONAL.TEAM_SHORT, 'Ekip rolünün kısa adı (kolon ve kartlarda)'],
  ['WORKFLOW', PERSONAL.WORKFLOW, 'İş akışın — AI her maili buna göre değerlendirir'],
  ['PRIORITY_RULES', PERSONAL.PRIORITY_RULES, 'P1–P5 öncelik tanımların'],
  ['ADDRESS_HINTS', PERSONAL.ADDRESS_HINTS, 'Şirket imzasındaki adres parçaları (marka sanılmasın)'],
  ['HIDDEN_COLUMNS', PERSONAL.HIDDEN_COLUMNS, 'Board\'da gizlenecek kolon kodları'],
  ['COLUMN_NAMES', PERSONAL.COLUMN_NAMES, 'Kolon adı değişiklikleri: KOD=Yeni ad; KOD=Yeni ad'],
  ['REPLY_OPENING', PERSONAL.REPLY_OPENING, 'Cevap taslağı açılışı'],
  ['REPLY_CLOSING', PERSONAL.REPLY_CLOSING, 'Cevap taslağı kapanışı (imza otomatik eklenir)'],
  ['REPLY_TONE', PERSONAL.REPLY_TONE, 'Cevap taslağı üslubu'],
  ['GEMINI_MODEL', 'gemini-3.8-flash', 'Ana model. Hata verirse FALLBACK_MODEL denenir'],
  ['FALLBACK_MODEL', 'gemini-3.5-flash-lite', 'Yedek model(ler), virgülle. Bunlar da olmazsa hesabında açık olan diğer Flash modelleri otomatik denenir'],
  ['LOOKBACK_DAYS', '14', 'Kaç günlük okunmamış mail taransın'],
  ['MAX_THREADS_PER_RUN', '80', 'Bir çalışmada en fazla kaç thread AI ile işlensin (paralel işlenir)'],
  ['AI_PARALLEL', '8', 'Aynı anda kaç Gemini isteği gönderilsin'],
  ['BACKFILL_WINDOW_DAYS', '3', 'Geçmiş mailleri sheet\'e çekerken her adımda kaç günlük dilim taransın'],
  ['DISTRIBUTION_PATTERNS', 'all@, tum@, tumu@, herkes@, team@, ekip@, internal@, everyone@, staff@, duyuru@', 'Dağıtım listesi adres parçaları'],
  ['IGNORE_BRANDS', PERSONAL.IGNORE_BRANDS, 'Artık bakmadığın markalar: sana direkt hitap etmiyorsa mail okundu yapılır, board\'a gelmez'],
  ['JIRA_PATTERNS', PERSONAL.JIRA_PATTERNS, 'Jira bildirim göndereni (adres parçası)'],
  ['JIRA_TEAMS', PERSONAL.JIRA_TEAMS || '', 'Board\'dan açılan Jira task\'lerinin Teams alanı (virgülle birden fazla, boşsa eklenmez)'],
  ['JIRA_TEAMS_FIELD', PERSONAL.JIRA_TEAMS_FIELD || '', 'Jira\'daki Teams alanının ID\'si (ör. customfield_10767)'],
  ['JIRA_START_FIELD', PERSONAL.JIRA_START_FIELD || '', 'Jira\'daki Start date alanının ID\'si (ör. customfield_10711); Due date her zaman bugün'],
  ['JIRA_COMMENT_STATUS', PERSONAL.JIRA_COMMENT_STATUS || 'To Do', 'Board\'dan Jira\'ya yorum yazınca task bu duruma alınır (boşsa durum değişmez)'],
  ['JIRA_COMMENT_DUE_TODAY', 'TRUE', 'Board\'dan Jira\'ya yorum yazınca task\'in Due date\'i bugün yapılır'],
  ['JIRA_SITE', PERSONAL.JIRA_SITE, 'Board\'dan task açmak / yorum yazmak için Jira adresi (ör. https://firma.atlassian.net)'],
  ['JIRA_TEAM_LABELS', PERSONAL.JIRA_TEAM_LABELS, 'Ekip → Jira etiketi (ör. SM=Sosyal_Medya, Google=Google_Ads)'],
  ['CLIENT_STALE_DAYS', '5', 'Markada Bekleyen iş bu kadar iş günü cevapsız kalırsa "Markada 5+ İş Günü" kolonuna düşer'],
  ['STALE_BUSINESS_DAYS', PERSONAL.STALE_BUSINESS_DAYS, 'Bu kadar iş gününden fazla hareketsiz kalan iş "3+ İş Günü Bekleyen" kolonuna düşer'],
  ['REMIND_WAIT_BUSINESS_DAYS', PERSONAL.REMIND_WAIT_BUSINESS_DAYS, 'Hatırlatmadan sonra CM bu kadar iş günü dönmezse kart tekrar 3+ İş Günü Bekleyen\'e düşer'],
  ['REMINDER_TEXT', PERSONAL.REMINDER_TEXT, 'CM hatırlatma mailinin metni (birebir gönderilir)'],
  ['FILTER_BY', PERSONAL.FILTER_BY, 'Board filtresi: KISI (ekip üyeleri) ya da MARKA (takip ettiğin markalar)'],
  ['BRANDS', PERSONAL.BRANDS, 'Markalar ve mail domainleri: "Marka=domain.com,domain2.com; Marka2=marka2.com"'],
  ['READ_CLOSES', PERSONAL.READ_CLOSES, 'EVET: Gmail\'de okunan mail board\'da Done olur (standart). HAYIR: kartlar sadece board\'dan kapanır'],
  ['P1_SLA_HOURS', '2', 'Hemen Cevapla kartı kaç saat sonra kırmızıya dönsün'],
  ['MARK_READ_ON_CLOSE', 'TRUE', 'Board üzerinden Tamamlandı/Done yapınca Gmail\'de okundu işaretle'],
  ['STAR_P1', 'TRUE', 'P1 maillere Gmail yıldızı ekle'],
  ['CLOSED_VISIBLE_DAYS', '7', 'Kapanan kartlar board\'da kaç gün görünsün'],
  ['PRUNE_CLOSED_DAYS', '60', 'Bu günden eski kapalı kayıtlar Tasks sayfasından silinir']
];

// İmza / yasal uyarı / sınıflandırma bandı kalıpları (AI metni ve konuşma görünümü için)
var DISCLAIMER_RES = [
  /bu e-?posta(nın)? ve (varsa )?ekleri/i,
  /bu (e-?posta|mesaj|ileti)(nın)? (içeriği )?(gizli|özel)/i,
  /yetkili muhatab/i,
  /kişisel verilerin (korunması|yetkisiz)/i,
  /this e-?mail (message )?(and any|is confidential|may contain)/i,
  /intended (solely |only )?for the (use of the )?(individual|addressee|named)/i,
  /confidentiality notice|disclaimer:/i,
  /please consider the environment|yazdırmadan önce/i
];
var BANNERS = ['herkese açık', 'genel', 'public', 'internal', 'internal use only', 'kişisel veri içermez', 'şirket içi', 'hizmete özel', 'gizli', 'confidential', 'sınıflandırma: genel', 'classification: public'];
var BANNER_RE = { test: function (t) { var f = fold_(t); return f.length > 0 && BANNERS.some(function (b) { return fold_(b) === f; }); } };
var SIGNOFF_RE = /^(saygılarımla|saygılarımızla|saygılar|iyi çalışmalar|kolay gelsin|teşekkürler|teşekkür ederim|teşekkür ederiz|sevgiler|sevgilerimle|görüşmek üzere|best regards|kind regards|regards|best|thanks|thank you|cheers)[\s,.!]*$/i;
var SIGNATURE_LINE_RE = /^(?:(?:t|m|f|tel|gsm|phone|mobile|telefon|cep|faks|fax)\s*[:.]\s*|(?:tel|gsm|phone|mobile|telefon)\s+)\+?[\d\s()\-]{7,}$|^(?:https?:\/\/)?www\.[a-z0-9-]+(?:\.[a-z]{2,}){1,3}\/?$/i;

// ============================================================
//  MENÜ & KURULUM
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('📋 Mail Board')
    .addItem('1) Kurulumu başlat / ayarları güncelle', 'setup')
    .addItem('2) Gemini API key gir', 'promptApiKey')
    .addItem('Gemini bağlantısını test et', 'testGemini')
    .addItem('3) Otomatik taramayı aç (10 dk) + geçmişi çek', 'installTrigger')
    .addItem('4) Jira\'yı bağla (API token)', 'promptJira')
    .addItem('Jira proje eşleştirmesini aç', 'openJiraMap')
    .addSeparator()
    .addItem('Şimdi tara (tam kontrol)', 'syncNowFull')
    .addItem('Açık kartları yeniden sınıfla', 'reclassifyOpen')
    .addItem('CM atamalarını yeniden hesapla (AI\'sız, hızlı)', 'reassignCms')
    .addItem('Geçmiş mail aktarımının durumu', 'backfillStatus')
    .addItem('Dijital ikiz (yazı avatarı) oluştur / güncelle', 'buildDigitalTwin')
    .addItem('Board linkini göster', 'showBoardUrl')
    .addItem('Otomatik taramayı kapat', 'removeTriggers')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  var st = ss.getSheetByName(SHEET_SETTINGS) || ss.insertSheet(SHEET_SETTINGS);
  if (st.getLastRow() < 1) {
    st.getRange(1, 1, 1, 3).setValues([['Anahtar', 'Değer', 'Açıklama']]).setFontWeight('bold');
  }
  // Eksik ayar anahtarlarını ekle (mevcut değerlere dokunmaz)
  var existing = st.getLastRow() > 1 ? st.getRange(2, 1, st.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); }) : [];
  var me = Session.getActiveUser().getEmail() || '';
  var missing = DEFAULT_SETTINGS.filter(function (r) { return existing.indexOf(r[0]) < 0; }).map(function (r) {
    var v = r[1];
    if (r[0] === 'MY_EMAIL' && !v) v = me;
    if (r[0] === 'INTERNAL_DOMAINS' && !v) v = me.split('@')[1] || '';
    return [r[0], v, r[2]];
  });
  if (missing.length) st.getRange(st.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
  st.setColumnWidth(1, 220); st.setColumnWidth(2, 360); st.setColumnWidth(3, 480);

  var cm = ss.getSheetByName(SHEET_CMS) || ss.insertSheet(SHEET_CMS);
  if (cm.getLastRow() < 2) {
    cm.clear();
    if (PERSONAL.TEAM.length) cm.getRange(2, 1, PERSONAL.TEAM.length, 4).setValues(PERSONAL.TEAM.map(function (r) { return [r[0] || '', r[1] || '', r[2] || '', r[3] || '']; }));
  }
  cm.getRange(1, 1, 1, 4).setValues([[(PERSONAL.TEAM_ROLE || 'Ekip üyesi') + ' (Ad Soyad)', 'Email', 'Markalar / sorumlu olduğu işler (virgülle)', 'Marka mail domainleri (virgülle, ör. marka.com)']]).setFontWeight('bold');
  cm.setColumnWidth(1, 200); cm.setColumnWidth(2, 260); cm.setColumnWidth(3, 360); cm.setColumnWidth(4, 360);

  var t = ss.getSheetByName(SHEET_TASKS) || ss.insertSheet(SHEET_TASKS);
  if (t.getLastRow() < 1) {
    t.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
    t.setFrozenRows(1);
  }
  var lg = ss.getSheetByName(SHEET_LOG) || ss.insertSheet(SHEET_LOG);
  if (lg.getLastRow() < 1) lg.getRange(1, 1, 1, 3).setValues([['Zaman', 'Seviye', 'Mesaj']]).setFontWeight('bold');

  ensureLabels_();
  SpreadsheetApp.getUi().alert(
    'Kurulum / güncelleme tamam.\n\n' +
    '• "ClientManagers" sayfasında CM\'lerin markalarını ve (varsa) marka mail domainlerini gir.\n' +
    '• "Ayarlar"a yeni anahtarlar eklendi (IGNORE_BRANDS, STALE_BUSINESS_DAYS, REMINDER_TEXT…).\n' +
    '• Apps Script > Services (+) > Gmail API ekli olmalı (KURULUM.md).\n' +
    '• Eski yanlış sınıflamalar için: menü > "Açık kartları yeniden sınıfla".');
}

function promptApiKey() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Gemini API key',
    'Key almak 1 dakika sürer:\n' +
    '1) Bu adresi aç: https://aistudio.google.com/apikey (iş hesabınla giriş yap)\n' +
    '2) "Create API key" → bir proje seç ya da "Create API key in new project"\n' +
    '3) Çıkan key\'in yanındaki kopyala simgesine bas (AIza… ile başlar)\n' +
    '4) Buraya yapıştır ve OK\'e bas. Bağlantıyı hemen test edeceğim.\n\n' +
    'Ücretsiz key de çalışır: kota dolarsa sistem diğer modelleri dener, olmazsa kartlar "AI bekliyor" rozetiyle gelir ve sonra otomatik sınıflanır.',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var key = r.getResponseText().trim().replace(/^["']|["']$/g, '');
  if (!/^AIza[0-9A-Za-z_\-]{30,}$/.test(key)) { ui.alert('Bu bir Gemini API key\'ine benzemiyor (AIza… ile başlamalı). Kopyalarken boşluk ya da eksik karakter kalmış olabilir, tekrar dene.'); return; }
  var sp = PropertiesService.getScriptProperties();
  sp.setProperty('GEMINI_API_KEY', key);
  ['AI_ERROR', 'AI_MODEL_LIST', 'AI_BAD_MODELS', 'AI_COOLDOWN_UNTIL'].forEach(function (k) { sp.deleteProperty(k); });
  ui.alert(testGemini_());
}
/** Menü: Gemini bağlantısını test et */
function testGemini() { SpreadsheetApp.getUi().alert(testGemini_()); }
function testGemini_() {
  var cfg = getConfig_();
  try {
    var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!key) return 'Henüz API key girilmemiş. Menü → "2) Gemini API key gir".';
    var models = geminiModels_(cfg, key);
    var t = callGemini_('Sadece şu JSON\'u döndür: {"ok": true}', cfg);
    PropertiesService.getScriptProperties().setProperty('AI_LAST_OK', new Date().toISOString());
    return '✅ Gemini çalışıyor.\nDenenecek modeller: ' + models.slice(0, 4).join(', ') + (/true/.test(t) ? '' : '\n(Yanıt beklenenden farklı ama bağlantı var.)');
  } catch (e) {
    var m = String(e);
    if (/API_KEY_INVALID|API key not valid|40[01]/.test(m)) return '❌ Key geçersiz görünüyor. aistudio.google.com/apikey sayfasından tekrar kopyalayıp gir.';
    if (/403|PERMISSION_DENIED/.test(m)) return '❌ Bu key\'in Gemini API izni yok ya da hesabında Gemini kapalı (şirket hesaplarında yönetici kapatmış olabilir). Kişisel bir Google hesabıyla key almayı dene.';
    if (/429|RESOURCE_EXHAUSTED/.test(m)) return '⚠️ Key doğru ama şu an kota dolu (ücretsiz katman). Sistem kurulumla devam edebilir; kartlar "AI bekliyor" olarak gelir ve kota açılınca sınıflanır. Yoğun kullanım için AI Studio\'da faturalandırmayı açabilirsin.';
    return '❌ Gemini\'ye bağlanılamadı: ' + m.slice(0, 300);
  }
}

function installTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('syncMail').timeBased().everyMinutes(10).create();
  if (PropertiesService.getScriptProperties().getProperty('BF_DONE') !== '1') {
    ScriptApp.newTrigger('backfillStep').timeBased().everyMinutes(5).create();
  }
  try { SpreadsheetApp.getUi().alert('Her 10 dakikada bir otomatik tarama açıldı.\nGeçmiş mailler 5 dakikada bir parça parça sheet\'e aktarılacak (bitince kendiliğinden durur).'); } catch (e) {}
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    var h = tr.getHandlerFunction();
    if (h === 'syncMail' || h === 'backfillStep') ScriptApp.deleteTrigger(tr);
  });
}

function showBoardUrl() {
  var url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert(url ? ('Board: ' + url) : 'Henüz web app olarak deploy edilmedi. Deploy > New deployment > Web app.');
}

/** Açık kartların AI sınıflamasını sıfırlar; sonraki taramalarda yeniden işlenir */
function reclassifyOpen() {
  var db = loadDb_();
  var n = 0;
  db.rows.forEach(function (r) {
    if (!isTrue_(r.closed)) { r.msgCount = ''; r.manualStatus = ''; r._dirty = true; n++; }
  });
  db.dirty = true;
  flushDb_(db);
  syncMail();
  try { SpreadsheetApp.getUi().alert(n + ' açık kart yeniden sınıflanıyor. Hepsi bitene kadar birkaç tarama sürebilir.'); } catch (e) {}
}

/** Açık kartların CM'ini maile kimlerin ekli olduğuna göre yeniden hesaplar (AI çağrısı yok) */
function reassignCms() {
  var cfg = getConfig_();
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  var changed = 0, started = Date.now();
  try {
    var db = loadDb_();
    db.rows.forEach(function (r) {
      if (isTrue_(r.closed) || Date.now() - started > 280000) return;
      try {
        var th = apiThread_(r.threadId); if (!th.exists()) return;
        var facts = extractFacts_(th, cfg, r);
        var cm = pickClientManager_(facts, cfg, { brand: r.brand }, String(r.flags || '').indexOf('MACHINE') < 0);
        if (cm.email !== (r.cmEmail || '')) {
          r.cm = cm.name; r.cmEmail = cm.email; r.hasCm = !!facts.hasCm;
          r.updatedAt = new Date().toISOString();
          applyBoardLabels_(th, r, cfg);
          r._dirty = true; db.dirty = true; changed++;
        }
      } catch (e) { log_('ERROR', 'CM yeniden atama ' + r.threadId + ': ' + e); }
    });
    flushDb_(db);
  } finally { lock.releaseLock(); }
  log_('INFO', 'CM yeniden atama: ' + changed + ' kart güncellendi.');
  try { SpreadsheetApp.getUi().alert(changed + ' kartın CM\'i güncellendi.'); } catch (e) {}
}

// ============================================================
//  AYARLAR
// ============================================================
function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

var _cfgCache = null;
function getConfig_() {
  if (_cfgCache) return _cfgCache;
  var ss = ss_();
  var cfg = {};
  DEFAULT_SETTINGS.forEach(function (r) { cfg[r[0]] = r[1]; });
  var st = ss.getSheetByName(SHEET_SETTINGS);
  if (st && st.getLastRow() > 1) {
    st.getRange(2, 1, st.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (r[0]) cfg[String(r[0]).trim()] = String(r[1]).trim();
    });
  }
  if (!cfg.MY_EMAIL) cfg.MY_EMAIL = Session.getActiveUser().getEmail() || '';
  if (!cfg.INTERNAL_DOMAINS) cfg.INTERNAL_DOMAINS = cfg.MY_EMAIL.split('@')[1] || '';
  cfg.myEmail = cfg.MY_EMAIL.toLowerCase();
  cfg.company = cfg.COMPANY_NAME || 'Şirket';
  cfg.firstName = (cfg.MY_NAME || cfg.myEmail.split('@')[0]).split(/\s+/)[0];
  cfg.teamRole = cfg.TEAM_ROLE || 'ekip üyesi';
  cfg.teamShort = cfg.TEAM_SHORT || 'Ekip';
  cfg.addrHints = splitList_(cfg.ADDRESS_HINTS).map(fold_);
  cfg.hiddenCols = splitList_(cfg.HIDDEN_COLUMNS).map(function (x) { return x.toUpperCase(); });
  cfg.colNames = {};
  String(cfg.COLUMN_NAMES || '').split(/[;\n]/).forEach(function (p) { var kv = p.split('='); if (kv.length === 2 && kv[0].trim()) cfg.colNames[kv[0].trim().toUpperCase()] = kv[1].trim(); });
  cfg.aliases = splitList_(cfg.MY_NAME_ALIASES);
  cfg.internalDomains = splitList_(cfg.INTERNAL_DOMAINS).map(lc_);
  cfg.distPatterns = splitList_(cfg.DISTRIBUTION_PATTERNS).map(lc_);
  cfg.ignoreBrands = splitList_(cfg.IGNORE_BRANDS).map(fold_);
  cfg.jiraPatterns = splitList_(cfg.JIRA_PATTERNS).map(lc_);
  cfg.lookback = parseInt(cfg.LOOKBACK_DAYS, 10) || 14;
  cfg.maxPerRun = Math.max(parseInt(cfg.MAX_THREADS_PER_RUN, 10) || 80, 60);
  cfg.parallel = Math.min(Math.max(parseInt(cfg.AI_PARALLEL, 10) || 8, 1), 15);
  // Son 24 saatte kota (429) görüldüyse küçük partilerle çalış (ücretsiz API key'lerde dakikalık limit düşük)
  if (Number(PropertiesService.getScriptProperties().getProperty('AI_THROTTLE_UNTIL') || 0) > Date.now()) cfg.parallel = Math.min(cfg.parallel, 3);
  cfg.bfWindow = Math.max(1, parseInt(cfg.BACKFILL_WINDOW_DAYS, 10) || 3);
  cfg.staleDays = parseInt(cfg.STALE_BUSINESS_DAYS, 10) || 3;
  cfg.filterBy = /^marka/i.test(String(cfg.FILTER_BY || '')) ? 'MARKA' : 'KISI';
  cfg.brandMap = String(cfg.BRANDS || '').split(/[;\n]/).map(function (x) {
    var m = x.split('='); var name = String(m[0] || '').trim();
    return name ? { name: name, domains: String(m[1] || '').split(',').map(function (d) { return lc_(d).trim().replace(/^@/, ''); }).filter(String) } : null;
  }).filter(Boolean);
  cfg.clientStaleDays = parseInt(cfg.CLIENT_STALE_DAYS, 10) || 5;
  cfg.remindWait = parseInt(cfg.REMIND_WAIT_BUSINESS_DAYS, 10) || 2;
  cfg.reminderText = cfg.REMINDER_TEXT || 'burada bir gelişme var mı';
  cfg.readCloses = !/^(hay[ıi]r|false|0|no|off)$/i.test(String(cfg.READ_CLOSES == null ? 'EVET' : cfg.READ_CLOSES).trim());
  cfg.slaHours = parseFloat(cfg.P1_SLA_HOURS) || 2;
  cfg.markReadOnClose = /^true$/i.test(cfg.MARK_READ_ON_CLOSE);
  cfg.starP1 = /^true$/i.test(cfg.STAR_P1);
  cfg.closedVisibleDays = parseInt(cfg.CLOSED_VISIBLE_DAYS, 10) || 7;
  cfg.pruneDays = parseInt(cfg.PRUNE_CLOSED_DAYS, 10) || 60;

  cfg.cms = [];
  var cm = ss.getSheetByName(SHEET_CMS);
  if (cm && cm.getLastRow() > 1) {
    var width = Math.max(3, Math.min(4, cm.getLastColumn()));
    cm.getRange(2, 1, cm.getLastRow() - 1, width).getValues().forEach(function (r) {
      if (r[0] && r[1]) cfg.cms.push({
        name: String(r[0]).trim(),
        email: String(r[1]).trim().toLowerCase(),
        brands: splitList_(r[2]),
        domains: splitList_(r[3] || '').map(function (d) { return lc_(d).replace(/^@/, ''); })
      });
    });
  }
  _cfgCache = cfg;
  return cfg;
}

function splitList_(s) {
  return String(s || '').split(/[,;\n]/).map(function (x) { return x.trim(); }).filter(String);
}
function lc_(s) { return String(s).toLowerCase(); }
/** Türkçe karakter + boşluk katlama: "Tıkla Gelsin" → "tiklagelsin" */
function fold_(s) {
  return String(s || '').toLowerCase()
    .replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's').replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o').replace(/[çÇ]/g, 'c')
    .replace(/i̇/g, 'i').replace(/[^a-z0-9]/g, '');
}

// ============================================================
//  GMAIL ERİŞİMİ — Gmail API (Advanced Service) üzerinden
//  GmailApp'in günlük "premium gmail" kotası (Workspace: 50.000 çağrı/gün) her getter'ı
//  (getFrom, getHeader, isUnread…) ayrı çağrı sayıyor ve tarama bunu dolduruyordu.
//  Gmail API ise thread'i TEK istekte (tüm mesajlar + başlıklar + gövdeler) getiriyor ve
//  ayrı, çok daha geniş bir kotaya tabi. Aşağıdaki sarmalayıcılar GmailApp arayüzünü taklit eder,
//  böylece geri kalan kod değişmeden çalışır.
// ============================================================
/**
 * Gmail API çağrı sarmalayıcısı: kullanıcı başına dakikada 6.000 birim sınırını aşmamak için
 * kendi kendini yavaşlatır, 429/5xx'te kısa bekleyip bir kez daha dener.
 */
var _gq = { start: 0, used: 0 };
var GMAIL_UNITS_PER_MIN = 4500;
function gapi_(units, fn) {
  var now = Date.now();
  if (now - _gq.start > 60000) { _gq.start = now; _gq.used = 0; }
  if (_gq.used + units > GMAIL_UNITS_PER_MIN) {
    Utilities.sleep(Math.max(0, 60000 - (now - _gq.start)) + 250);
    _gq.start = Date.now(); _gq.used = 0;
  }
  _gq.used += units;
  for (var attempt = 0; ; attempt++) {
    try { return fn(); }
    catch (e) {
      var msg = String(e);
      // Dakikalık kota (aynı anda çalışan tarama + board işlemleri toplamı) → bekle, tekrar dene
      if (attempt < 4 && /Quota exceeded|Units per minute|User-rate limit|userRateLimitExceeded|Too many concurrent/i.test(msg)) { Utilities.sleep(8000 * (attempt + 1)); _gq.start = Date.now(); _gq.used = 0; continue; }
      if (attempt < 2 && /429|rate limit|rateLimitExceeded|backendError|500|503/i.test(msg)) { Utilities.sleep(3000 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

function apiThread_(id) { return id ? new ApiThread_(String(id)) : null; }

function ApiThread_(id) { this._id = id; this._t = null; this._msgs = null; }
ApiThread_.prototype._get = function () {
  var id = this._id;
  if (!this._t) {
    try { this._t = gapi_(40, function () { return Gmail.Users.Threads.get('me', id, { format: 'full' }); }); }
    catch (e) {
      // Çok büyük thread'lerde tek istekte yanıt sığmıyor (413) → mesajları tek tek indir
      if (!/413|too large/i.test(String(e))) throw e;
      var t = gapi_(10, function () { return Gmail.Users.Threads.get('me', id, { format: 'minimal' }); });
      t.messages = (t.messages || []).map(function (m) { return gapi_(5, function () { return Gmail.Users.Messages.get('me', m.id, { format: 'full' }); }); });
      this._t = t;
    }
  }
  return this._t;
};
ApiThread_.prototype.exists = function () { try { this._get(); return true; } catch (e) { if (/not found|404/i.test(String(e))) return false; throw e; } };
ApiThread_.prototype.getId = function () { return this._id; };
ApiThread_.prototype.getMessages = function () {
  if (!this._msgs) this._msgs = (this._get().messages || []).map(function (m) { return new ApiMsg_(m); });
  return this._msgs;
};
ApiThread_.prototype.getMessageCount = function () { return this.getMessages().length; };
ApiThread_.prototype.getFirstMessageSubject = function () { var m = this.getMessages()[0]; return m ? m.getSubject() : ''; };
ApiThread_.prototype.getLastMessageDate = function () { var ms = this.getMessages(); return ms.length ? ms[ms.length - 1].getDate() : new Date(0); };
ApiThread_.prototype.isUnread = function () { return this.getMessages().some(function (m) { return m._labels.indexOf('UNREAD') >= 0; }); };
ApiThread_.prototype.labelIds = function () {
  var o = {}; this.getMessages().forEach(function (m) { m._labels.forEach(function (l) { o[l] = true; }); }); return Object.keys(o);
};
ApiThread_.prototype.modifyLabels = function (add, remove) {
  add = (add || []).filter(String); remove = (remove || []).filter(String);
  if (!add.length && !remove.length) return;
  var id = this._id;
  gapi_(10, function () { return Gmail.Users.Threads.modify({ addLabelIds: add, removeLabelIds: remove }, 'me', id); });
  var ms = this._msgs || [];
  ms.forEach(function (m) {
    m._labels = m._labels.filter(function (l) { return remove.indexOf(l) < 0; });
    add.forEach(function (l) { if (m._labels.indexOf(l) < 0) m._labels.push(l); });
  });
};
ApiThread_.prototype.markRead = function () { this.modifyLabels([], ['UNREAD']); };
ApiThread_.prototype.markUnread = function () { this.modifyLabels(['UNREAD'], []); };
ApiThread_.prototype.unstarAll = function () { this.modifyLabels([], ['STARRED']); };

function ApiMsg_(m) {
  this._m = m;
  this._labels = (m.labelIds || []).slice();
  var h = {};
  ((m.payload && m.payload.headers) || []).forEach(function (x) { var k = lc_(x.name); if (!(k in h)) h[k] = x.value; });
  this._h = h;
}
ApiMsg_.prototype.getId = function () { return this._m.id; };
ApiMsg_.prototype.isDraft = function () { return this._labels.indexOf('DRAFT') >= 0; };
ApiMsg_.prototype.isStarred = function () { return this._labels.indexOf('STARRED') >= 0; };
ApiMsg_.prototype.star = function () { var id = this._m.id; gapi_(5, function () { return Gmail.Users.Messages.modify({ addLabelIds: ['STARRED'] }, 'me', id); }); this._labels.push('STARRED'); };
ApiMsg_.prototype.unstar = function () { var id = this._m.id; gapi_(5, function () { return Gmail.Users.Messages.modify({ removeLabelIds: ['STARRED'] }, 'me', id); }); };
ApiMsg_.prototype.getHeader = function (n) { return this._h[lc_(n)] || ''; };
ApiMsg_.prototype.getFrom = function () { return this._h['from'] || ''; };
ApiMsg_.prototype.getTo = function () { return this._h['to'] || ''; };
ApiMsg_.prototype.getCc = function () { return this._h['cc'] || ''; };
ApiMsg_.prototype.getSubject = function () { return this._h['subject'] || ''; };
ApiMsg_.prototype.getDate = function () { return new Date(Number(this._m.internalDate || 0)); };
ApiMsg_.prototype._part = function (mime) {
  var found = null;
  (function walk(p) {
    if (!p || found) return;
    var disp = '';
    (p.headers || []).forEach(function (x) { if (lc_(x.name) === 'content-disposition') disp = x.value; });
    if (lc_(p.mimeType || '') === mime && p.body && p.body.data && !/attachment/i.test(disp)) { found = p; return; }
    (p.parts || []).forEach(walk);
  })(this._m.payload);
  return found;
};
ApiMsg_.prototype.getPlainBody = function () {
  var p = this._part('text/plain');
  if (p) return decodePart_(p);
  var h = this._part('text/html');
  if (h) return decodePart_(h).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  return this._m.snippet || '';
};
ApiMsg_.prototype.getBody = function () {
  var h = this._part('text/html');
  if (h) return decodePart_(h);
  var p = this._part('text/plain');
  return p ? '<div style="white-space:pre-wrap">' + escHtml_(decodePart_(p)) + '</div>' : '';
};
ApiMsg_.prototype.getAttachments = function () {
  var out = [];
  (function walk(p) {
    if (!p) return;
    if (p.filename || lc_(p.mimeType || '') === 'text/calendar') {
      out.push({ getName: function () { return p.filename || ''; }, getContentType: function () { return p.mimeType || ''; } });
    }
    (p.parts || []).forEach(walk);
  })(this._m.payload);
  return out;
};

/** MIME parçasının gövdesini kendi karakter setiyle çözer (Outlook'un windows-1254'ü dahil) */
function decodePart_(p) {
  var data = p.body.data;
  var bytes = typeof data === 'string' ? Utilities.base64DecodeWebSafe(data) : data;
  var cs = 'UTF-8';
  (p.headers || []).forEach(function (x) {
    if (lc_(x.name) === 'content-type') { var m = /charset="?([^";\s]+)"?/i.exec(x.value); if (m) cs = m[1]; }
  });
  var txt;
  try { txt = Utilities.newBlob(bytes).getDataAsString(cs); } catch (e) { txt = Utilities.newBlob(bytes).getDataAsString('UTF-8'); cs = 'UTF-8'; }
  // Bazı mailler charset'i yanlış beyan ediyor (UTF-8 baytları latin-1 diye): "yayÄ±na", "TeÅ\u009fekkÃ¼rler" → UTF-8 ile tekrar çöz
  if (!/^utf-?8$/i.test(cs) && /[ÃÄÅ][\u0080-\u00BF\u0100-\u017F]/.test(txt)) {
    try { var u = Utilities.newBlob(bytes).getDataAsString('UTF-8'); if (u.indexOf('\uFFFD') < 0) return u; } catch (e) {}
  }
  return txt;
}

/** Gmail araması → thread sarmalayıcıları (thread'ler ancak kullanılınca indirilir) */
function apiSearch_(q, max, labelIds) {
  var out = [], token = null;
  do {
    var args = { maxResults: Math.min(500, max - out.length) };
    if (q) args.q = q;
    if (labelIds) args.labelIds = labelIds;
    if (token) args.pageToken = token;
    var res = gapi_(10, function () { return Gmail.Users.Threads.list('me', args); });
    (res.threads || []).forEach(function (t) { out.push(apiThread_(t.id)); });
    token = res.nextPageToken;
  } while (token && out.length < max);
  return out;
}

// ============================================================
//  LABEL YÖNETİMİ (Gmail API)
// ============================================================
var _labels = null;   // { byName: {name: id}, byId: {id: name} }
function labels_(refresh) {
  if (_labels && !refresh) return _labels;
  _labels = { byName: {}, byId: {} };
  (gapi_(1, function () { return Gmail.Users.Labels.list('me'); }).labels || []).forEach(function (l) { _labels.byName[l.name] = l.id; _labels.byId[l.id] = l.name; });
  return _labels;
}
function labelId_(name) {
  var L = labels_();
  if (L.byName[name]) return L.byName[name];
  var parts = name.split('/');
  for (var i = 1; i <= parts.length; i++) {
    var n = parts.slice(0, i).join('/');
    if (!L.byName[n]) {
      try {
        var l = Gmail.Users.Labels.create({ name: n, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, 'me');
        L.byName[n] = l.id; L.byId[l.id] = n;
      } catch (e) { labels_(true); L = _labels; }
    }
  }
  return L.byName[name];
}
function boardLabelIds_() {
  var L = labels_();
  return Object.keys(L.byName).filter(function (n) { return n.indexOf(LABEL_ROOT + '/') === 0; }).map(function (n) { return L.byName[n]; });
}
function ensureLabels_() {
  labels_(true);
  labelId_(LABEL_ROOT);
  Object.keys(PRIORITY_LABELS).forEach(function (k) { labelId_(PRIORITY_LABELS[k]); });
  labelId_(JIRA_LABEL);
}
function getOrCreateLabel_(name) { return labelId_(name); }

function removeBoardLabels_(thread) {
  var board = boardLabelIds_();
  var has = thread._msgs ? thread.labelIds().filter(function (l) { return board.indexOf(l) >= 0; }) : board;
  if (has.length) thread.modifyLabels([], has);
}

function applyBoardLabels_(thread, row, cfg) {
  var target = [];
  if (isJiraStatus_(row.status) || isJiraStatus_(row.aiStatus)) target.push(labelId_(JIRA_LABEL));
  else target.push(labelId_(PRIORITY_LABELS[row.priority] || PRIORITY_LABELS[5]));
  if (row.cm && row.cm !== 'Atanmamış') target.push(labelId_(LABEL_ROOT + '/CM/' + row.cm));
  // Durum label'ları: Gmail'den (ör. Grok Bot'un Gmail bağlantısı) board durumunu görmek için
  if (STATUS_LABELS[row.status]) target.push(labelId_(STATUS_LABELS[row.status]));
  var board = boardLabelIds_();
  var current = thread._msgs ? thread.labelIds() : board;
  var remove = current.filter(function (l) { return board.indexOf(l) >= 0 && target.indexOf(l) < 0; });
  var add = target.filter(function (l) { return !thread._msgs || current.indexOf(l) < 0; });
  thread.modifyLabels(add, remove);
  if (cfg.starP1 && Number(row.priority) === 1 && row.status === 'MY_REPLY') {
    var msgs = thread.getMessages();
    var last = msgs[msgs.length - 1];
    if (last && !last.isStarred()) last.star();
  }
}

function boardLabelNames_() {
  var names = Object.keys(PRIORITY_LABELS).map(function (k) { return PRIORITY_LABELS[k]; });
  names.push(JIRA_LABEL);
  return names;
}

// ============================================================
//  ANA TARAMA
// ============================================================
function syncMail() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(45000)) { log_('WARN', 'Başka bir arka plan işi sürüyor, tarama atlandı.'); return; }
  var started = Date.now();
  try {
    var cfg = getConfig_();
    ensureLabels_();
    var db = loadDb_();
    db.guardSince = started;
    var sp = PropertiesService.getScriptProperties();

    var base = ' -in:spam -in:trash -in:drafts -in:chats';
    var seenIds = {}, threads = [];
    var add = function (list) { list.forEach(function (t) { if (!t) return; var id = t.getId(); if (!seenIds[id]) { seenIds[id] = true; threads.push(t); } }); };
    var closedCount = 0, reopened = 0, fullInfo = '';
    var profileHistory = Gmail.Users.getProfile('me').historyId;   // bu turun başlangıç noktası

    // 1+2) Gmail History API: sadece son turdan beri DEĞİŞEN thread'ler (yeni mesaj, okundu/okunmadı).
    //      Eskiden her turda yüzlerce thread tek tek kontrol ediliyordu → Gmail günlük kotası doldu.
    var hist = gmailChanges_(sp.getProperty('HISTORY_ID'));
    if (hist) {
      hist.readIds.forEach(function (id) {
        var row = db.byId[id];
        if (!cfg.readCloses || !row || isTrue_(row.closed) || isTrue_(row.followUp) || isSticky_(row.manualStatus) || hist.changedIds.indexOf(id) >= 0) return;
        try {
          var th = apiThread_(id);
          if (th && !th.isUnread()) {
            removeBoardLabels_(th);
            markClosed_(row, 'DONE', 'okundu');
            saveRow_(db, row); closedCount++;
          }
        } catch (e) {}
      });
      hist.changedIds.concat(hist.unreadIds).forEach(function (id) {
        if (seenIds[id]) return;
        try { var t = apiThread_(id); if (t.exists()) add([t]); } catch (e) {}
      });
    }
    // Güvenlik ağı: saatte bir tam kontrol (History yoksa/sıfırlandıysa her turda)
    var lastFull = Number(sp.getProperty('LAST_FULL_CHECK') || 0);
    if (!hist || Date.now() - lastFull > 3600000) {
      if (cfg.readCloses) closedCount += closeReadThreads_(db, cfg);
      var lastSync = sp.getProperty('LAST_SYNC');
      if (!hist) {
        var since = lastSync ? Math.floor(new Date(lastSync).getTime() / 1000) - 3600 : Math.floor(Date.now() / 1000) - 2 * 86400;
        add(apiSearch_('after:' + since + base, 300));
      }
      // Onarım: Gmail'deki TÜM okunmamış thread'ler (500 sınırı yok) sheet ve label'larla eşitlenir
      var rep = repairUnread_(db, cfg, base, seenIds, threads, started);
      reopened += rep.reopened;
      if (rep.complete) sp.setProperty('LAST_FULL_CHECK', String(Date.now()));
      else log_('INFO', 'Tam kontrol yarıda kaldı (süre), bir sonraki turda devam edecek.');
      fullInfo = ' [tam kontrol: ' + rep.unread + ' okunmamış, ' + rep.relabeled + ' label eklendi, ' + rep.added + ' yeni kayıt, ' + (rep.closedRead || 0) + ' okunmuş kart kapandı]';
    }

    var processed = 0, ignored = 0, aiPending = 0, archivedRead = 0, timedOut = false;
    var fresh = [];
    threads.forEach(function (th) {
      var row = db.byId[th.getId()];
      if (row && row.msgCount !== '') {
        if (Number(row.msgCount) === th.getMessageCount()) {
          if (isTrue_(row.closed) && row.status !== 'IGNORED' && th.isUnread()) { reopenRow_(row, th, cfg); saveRow_(db, row); reopened++; }
          return;
        }
      } else if (row) return;            // AI / yeniden sınıflama kuyruğunda; aşağıda ele alınır
      fresh.push({ th: th, row: row });
    });
    var queue = fresh.slice(0, cfg.maxPerRun);
    var room = cfg.maxPerRun - queue.length;
    db.rows.forEach(function (r) {
      if (room <= 0 || isTrue_(r.closed) || r.msgCount !== '') return;
      try {
        var th = seenIds[r.threadId] ? threads.filter(function (t) { return t.getId() === r.threadId; })[0] : apiThread_(r.threadId);
        if (th && th.exists()) { queue.push({ th: th, row: r }); room--; }
      } catch (e) {}
    });

    // 3) Parça parça işle: yeni mesajları oku (Gmail) → Gemini (paralel) → kaydet
    for (var qi = 0; qi < queue.length; qi += cfg.parallel) {
      if (Date.now() - started > 270000) { timedOut = true; break; }
      var work = [];
      queue.slice(qi, qi + cfg.parallel).forEach(function (q) {
        var id = q.th.getId();
        try {
          var facts = extractFacts_(q.th, cfg, q.row);
          if (facts.ignoredBrand && !facts.directToMe) {
            q.th.markRead();
            removeBoardLabels_(q.th);
            saveRow_(db, ignoredRow_(q.row, facts, cfg));
            ignored++;
            return;
          }
          work.push({ th: q.th, row: q.row, facts: facts, prompt: buildPrompt_(facts, cfg) });
        } catch (err) { log_('ERROR', 'Thread ' + id + ' okunamadı: ' + err); }
      });
      if (!work.length) continue;
      var answers = aiBlocked_() ? work.map(function () { return null; })
                                 : geminiBatch_(work.map(function (w) { return w.prompt; }), cfg);
      var replyJobs = [];
      work.forEach(function (w, k) {
        var ai = answers[k];
        if (!ai && w.row && w.row.lastMsgId === w.facts.lastMsgId && String(w.row.flags || '').indexOf('AI_PENDING') < 0) return;
        try {
          var newRow = processThread_(w.th, w.facts, cfg, w.row, ai || heuristicAi_(w.facts));
          meetingNotesOverride_(newRow, w.facts.lastSenderEmail, w.facts.subject);
          if (ai) {
            // Thread hafızası + önbellek sadece AI yeni mesajları gerçekten okuduysa ilerler
            newRow.memory = String(ai.memory || (w.row && w.row.memory) || '').slice(0, 12000);
            newRow.factsCache = JSON.stringify(w.facts.cache).slice(0, 45000);
          } else {
            newRow.memory = (w.row && w.row.memory) || '';
            newRow.factsCache = (w.row && w.row.factsCache) || '';
            newRow.msgCount = '';                     // kuyrukta kalsın, AI dönünce yeniden sınıflanır
            newRow.flags = (newRow.flags ? newRow.flags + ',' : '') + 'AI_PENDING';
            aiPending++;
          }
          // Takip: 3+ iş günü bekleyen (ya da hatırlatılmış) karta SEN yazdıysan → Hatırlatma Yapıldı.
          // Başka biri (CM) yazdıysa takip biter, kart normal akışa döner.
          var prevFollow = w.row && (w.row.status === 'STALE' || w.row.status === 'REMINDED' || isTrue_(w.row.followUp));
          if (w.row && isSticky_(w.row.manualStatus) && !isTrue_(w.row.closed)) {
            // Yakın Takip: senin takibe aldığın kart, yeni mesaj gelse de okunsa da burada kalır (sen çıkarana kadar)
            newRow.status = w.row.manualStatus; newRow.manualStatus = w.row.manualStatus; newRow.followUp = false;
            newRow.closed = false; newRow.closedAt = ''; newRow.closedBy = '';
          } else if (prevFollow && w.facts.lastSenderRole === 'ME') {
            newRow.status = 'REMINDED'; newRow.followUp = true; newRow.remindedAt = w.facts.lastDate;
            newRow.manualStatus = ''; newRow.closed = false; newRow.closedAt = ''; newRow.closedBy = '';
          } else {
            newRow.followUp = false;
          }
          applyStale_(newRow, cfg);
          if (closeIfIFinished_(newRow, w.th, cfg)) { statusLog_(w.row, newRow, 'tarama'); saveRow_(db, newRow); processed++; return; }
          var myOpen = w.facts.lastSenderRole === 'ME' && ['WAITING_CLIENT', 'WAITING_CM', 'IN_PROGRESS'].indexOf(newRow.status) >= 0 && /^Cevabında/.test(newRow.priorityReason || '');
          if (cfg.readCloses && !w.th.isUnread() && !isTrue_(newRow.followUp) && !isSticky_(newRow.manualStatus) && !myOpen) {
            // Okunmuş thread (ör. sen cevap yazdın, ya da sen okudun) → bilgisi güncel ama Done
            removeBoardLabels_(w.th);
            markClosed_(newRow, 'DONE', 'okundu');   // okunan her şey Done'a (İş Tamamlandı sadece açık işler için)
            archivedRead++;
          } else {
            applyBoardLabels_(w.th, newRow, cfg);
          }
          statusLog_(w.row, newRow, 'tarama');
          saveRow_(db, newRow);
          if (ai && newRow.status === 'MY_REPLY' && !isTrue_(newRow.closed) && !/(^|,)(CALENDAR|CAL_RESPONSE|MEETING_NOTES)(,|$)/.test(String(newRow.flags || ''))) replyJobs.push({ row: newRow, facts: w.facts });   // takvim/toplantı notuna oto cevap yok
          processed++;
        } catch (err) {
          log_('ERROR', 'Thread ' + w.facts.threadId + ' işlenemedi: ' + err + (err.stack ? '\n' + err.stack : ''));
        }
      });
      if (replyJobs.length && Date.now() - started < 240000) {
        try {
          var rAns = geminiBatch_(replyJobs.map(function (j) { return buildReplyPrompt_(j.facts, cfg, j.row.memory, ''); }), cfg);
          replyJobs.forEach(function (j, k) { var t = cleanReply_(rAns[k]); if (t) { j.row.suggestedReply = t; j.row._dirty = true; db.dirty = true; } });
        } catch (e) { log_('WARN', 'Cevap taslağı yazılamadı: ' + e); }
      }
    }
    if (timedOut) log_('WARN', 'Süre limiti, kalanlar bir sonraki turda.');
    if (sp.getProperty('FIX_READ_DONE_V1') !== '1') {
      var fx1 = 0, fx2 = 0;
      db.rows.forEach(function (r) {
        if (isTrue_(r.closed) && r.status === 'COMPLETED' && r.closedBy === 'okundu') { r.status = 'DONE'; r._dirty = true; fx1++; }
        else if (!isTrue_(r.closed) && !r.manualStatus && r.status === 'FYI' && String(r.flags || '').indexOf('CALENDAR') >= 0 && r.lastSenderRole !== 'ME') {
          r.status = 'MY_REPLY'; r.aiStatus = 'MY_REPLY'; r.priorityReason = 'Takvim daveti — katılım yanıtı bekleniyor'; r._dirty = true; fx2++;
        }
      });
      if (fx1 || fx2) db.dirty = true;
      sp.setProperty('FIX_READ_DONE_V1', '1');
      log_('INFO', 'Düzeltme: okunmuş ' + fx1 + ' kart İş Tamamlandı → Done, ' + fx2 + ' takvim daveti → Hemen Cevapla.');
    }
    if (sp.getProperty('FIX_JIRA_ME_V1') !== '1') {
      var fjm = 0, jlim = Date.now() - 21 * 86400000;
      db.rows.forEach(function (r) {
        if (isTrue_(r.closed) || r.manualStatus || (r.status !== 'JIRA' && r.aiStatus !== 'JIRA') || new Date(r.lastDate).getTime() < jlim || r.msgCount === '') return;
        r.msgCount = ''; r._dirty = true; fjm++;
      });
      if (fjm) db.dirty = true;
      sp.setProperty('FIX_JIRA_ME_V1', '1');
      log_('INFO', 'Jira: ' + fjm + ' açık Jira kartı "bana seslenildi / yorum yaptığım iş" kuralıyla yeniden sınıflanacak.');
    }
    if (sp.getProperty('FIX_JIRA_DELEGATED_V1') !== '1') {
      var fjd = 0;
      db.rows.forEach(function (r) {
        if (isTrue_(r.closed) || r.status !== 'WAITING_CM' || r.manualStatus || !/(^|,)JIRA(,|$)/.test(String(r.flags || '')) || String(r.priorityReason || '').indexOf('Jira yorumunda işi ekibe verdin') !== 0) return;
        r.status = 'JIRA'; r.aiStatus = 'JIRA'; r.priorityReason = String(r.priorityReason).replace('dönüşleri bekleniyor', 'ekibin alması bekleniyor');
        r._dirty = true; db.dirty = true; fjd++;
      });
      sp.setProperty('FIX_JIRA_DELEGATED_V1', '1');
      if (fjd) log_('INFO', 'Jira: ekibe iş verdiğin ' + fjd + ' kart "CM Cevabı Bekleniyor"dan "Jira · Alınmayı Bekliyor"a taşındı.');
    }
    if (sp.getProperty('FIX_JIRA_STAGE_V7') !== '1' && jiraCreds_() && Date.now() - started < 150000) {
      var fjs = 0, fjsDone = true, fjsStart = Date.now();
      db.rows.forEach(function (r) {
        if (isTrue_(r.closed) || isSticky_(r.manualStatus) || r.manualStatus) return;
        var jf = /(^|,)JIRA(,|$)/.test(String(r.flags || ''));
        if (!(isJiraStatus_(r.status) || (jf && (r.status === 'MY_REPLY' || r.status === 'WAITING_CM')))) return;
        if (Date.now() - fjsStart > 90000) { fjsDone = false; return; }
        var k = (String(r.subject || '').match(JIRA_KEY_RE_) || [])[1]; if (!k) return;
        try {
          if (applyJiraStage_(r, jiraStageOf_(k))) {
            r._dirty = true; db.dirty = true; fjs++;
            try { applyBoardLabels_(apiThread_(r.threadId), r, cfg); } catch (e) {}
          }
        } catch (e) {}
      });
      if (fjsDone) sp.setProperty('FIX_JIRA_STAGE_V7', '1');
      log_('INFO', 'Jira aşamaları: ' + fjs + ' Jira kartı ekip almadı / ekip yapıyor / ekip tamamladı sütunlarına ayrıldı' + (fjsDone ? '.' : ' (devam edecek).'));
    }
    if (sp.getProperty('FIX_MEETING_NOTES_V1') !== '1') {
      var fmn = 0;
      db.rows.forEach(function (r) {
        if (isTrue_(r.closed) || !/^\s*notes for/i.test(String(r.subject || '')) || !/circleback/i.test(String(r.participants || '') + ' ' + String(r.lastSender || ''))) return;
        meetingNotesOverride_(r, 'notifications@circleback.ai', r.subject); r._dirty = true; fmn++;
        try { applyBoardLabels_(apiThread_(r.threadId), r, cfg); } catch (e) {}
      });
      if (fmn) db.dirty = true;
      sp.setProperty('FIX_MEETING_NOTES_V1', '1');
      log_('INFO', 'Toplantı notları: ' + fmn + ' Circleback kartı Hemen Cevapla\'ya alındı.');
    }
    if (sp.getProperty('FIX_STATUS_LABELS_V1') !== '1' && Date.now() - started < 200000) {
      var fsl = 0;
      db.rows.forEach(function (r) {
        if (isTrue_(r.closed) || !STATUS_LABELS[r.status] || Date.now() - started > 240000) return;
        try { applyBoardLabels_(apiThread_(r.threadId), r, cfg); fsl++; } catch (e) {}
      });
      sp.setProperty('FIX_STATUS_LABELS_V1', '1');
      log_('INFO', 'Durum label\'ları eklendi: ' + fsl + ' kart (Board/Hemen Cevapla, Board/Yakin Takip).');
    }
    if (sp.getProperty('FIX_STYLE_V1') !== '1') {
      var fst = 0;
      db.rows.forEach(function (r) {
        if (isTrue_(r.closed) || r.status !== 'MY_REPLY' || r.msgCount === '') return;
        r.msgCount = ''; r._dirty = true; fst++;
      });
      if (fst) db.dirty = true;
      sp.setProperty('FIX_STYLE_V1', '1');
      log_('INFO', 'Düzeltme: Hemen Cevapla\'daki ' + fst + ' kartın cevap taslağı yazı avatarıyla yeniden yazılacak.');
    }
    if (sp.getProperty('FIX_DUE_V2') !== '1') {
      var fdu2 = 0;
      db.rows.forEach(function (r) {
        if (isTrue_(r.closed) || r.manualStatus || isTrue_(r.followUp) || !/(^|,)DUE:/.test(String(r.flags || ''))) return;
        if (r.msgCount !== '') { r.msgCount = ''; r._dirty = true; fdu2++; }
      });
      if (fdu2) db.dirty = true;
      sp.setProperty('FIX_DUE_V2', '1');
      log_('INFO', 'Düzeltme: teslim tarihli ' + fdu2 + ' kart yeniden sınıflanacak (bilgi/uyarı tarihleri teslim tarihi sayılmaz).');
    }
    if (sp.getProperty('FIX_DUE_V1') !== '1') {
      var fdu = 0;
      db.rows.forEach(function (r) {
        if (isTrue_(r.closed) || r.manualStatus || isTrue_(r.followUp)) return;
        if (STALE_SOURCE.indexOf(r.aiStatus) >= 0 && r.msgCount !== '') { r.msgCount = ''; r._dirty = true; fdu++; }
      });
      if (fdu) db.dirty = true;
      sp.setProperty('FIX_DUE_V1', '1');
      log_('INFO', 'Düzeltme: ' + fdu + ' açık iş ileri tarihli talep (teslim tarihi) için yeniden sınıflanacak.');
    }
    if (sp.getProperty('FIX_CLIENT_WAIT_V2') !== '1') {
      var fcw2 = 0;
      db.rows.forEach(function (r) {
        if (isTrue_(r.closed) || r.manualStatus || isTrue_(r.followUp)) return;
        if (r.status === 'COMPLETED' && ['CM', 'INTERNAL', 'ME'].indexOf(r.lastSenderRole) >= 0 && (String(r.updatedAt || '') >= '2026-09-29T23:30' || /^Teslim\/bilgilendirme yapıldı/.test(r.priorityReason || ''))) {
          r.msgCount = ''; r._dirty = true; fcw2++;
        }
      });
      if (fcw2) db.dirty = true;
      sp.setProperty('FIX_CLIENT_WAIT_V2', '1');
      log_('INFO', 'Düzeltme: son kuralla İş Tamamlandı\'ya geçen ' + fcw2 + ' kart yeniden sınıflanacak (markadan talep kontrolü AI + kural).');
    }
    if (sp.getProperty('FIX_CLIENT_WAIT_V1') !== '1') {
      var fcw = 0;
      db.rows.forEach(function (r) {
        if (isTrue_(r.closed) || isTrue_(r.followUp) || isSticky_(r.status) || r.status === 'LATER') return;
        if (!r.manualStatus && (r.status === 'WAITING_CLIENT' || r.status === 'CLIENT_STALE') && ['CM', 'INTERNAL', 'ME'].indexOf(r.lastSenderRole) >= 0 && !cacheOf_(r).lastBody) {
          r.msgCount = ''; r._dirty = true; fcw++;
        }
      });
      if (fcw) db.dirty = true;
      sp.setProperty('FIX_CLIENT_WAIT_V1', '1');
      log_('INFO', 'Düzeltme: Markada Bekleyen ' + fcw + ' kart "markadan gerçekten bir şey istendi mi" kuralıyla yeniden sınıflanacak.');
    }
    // Tek seferlik: mevcut kartlar için "son 3 mesajdan biri benim mi" bilgisini doldur (parça parça)
    if (!timedOut && sp.getProperty('RECENT_MINE_DONE') !== '1') {
      try { if (backfillRecentMine_(db, cfg, started)) { sp.setProperty('RECENT_MINE_DONE', '1'); log_('INFO', '"Benim aktif" filtresi için mevcut kartlar hazırlandı.'); } }
      catch (e) { log_('WARN', 'Benim aktif doldurma: ' + e); }
    }
    var unseen = Math.max(0, fresh.length - Math.min(fresh.length, processed + ignored));
    var pending = db.rows.filter(function (r) { return !isTrue_(r.closed) && r.msgCount === ''; }).length;

    // 4) Açık işlerde 3+ iş günü kontrolü
    db.rows.forEach(function (r) { if (applyStale_(r, cfg)) { r._dirty = true; db.dirty = true; } });

    flushDb_(db);
    // Kuyrukta iş kaldıysa ilerleme noktasını ilerletme → kaçan değişiklik olmaz
    if (!timedOut && !unseen) {
      sp.setProperty('LAST_SYNC', new Date(started).toISOString());
      if (profileHistory) sp.setProperty('HISTORY_ID', String(profileHistory));
    }
    sp.deleteProperty('SYNC_ERROR');
    log_('INFO', 'Tarama' + (hist ? '' : ' (tam)') + ': ' + processed + ' işlendi (' + archivedRead + ' okunmuş → Done), ' + closedCount + ' kapandı, ' + reopened + ' yeniden açıldı, ' + ignored + ' yok sayıldı' + (unseen ? ', ' + unseen + ' değişen thread sırada' : '') + (pending ? ', ' + pending + ' kart AI bekliyor' : '') + (aiPending ? ' (AI çalışmadı: ' + aiPending + ' kart kurallarla geçici sınıflandı)' : '') + '.' + fullInfo);
  } catch (e) {
    reportSyncError_(e);
  } finally {
    lock.releaseLock();
  }
}

/** Tarama hatasını Log'a yazar ve board'da uyarı olarak gösterir (eskiden sessizce "Failed" oluyordu) */
function reportSyncError_(e) {
  var msg = String(e && e.message || e);
  var quota = /too many times|invoked too many|quota|limit exceeded|rate limit/i.test(msg);
  var text = quota ? 'Gmail günlük kullanım kotası doldu; kota 24 saat içinde kendiliğinden yenilenir, tarama sonra otomatik devam eder. (' + msg + ')' : msg;
  log_('ERROR', 'Tarama durdu: ' + text + (e && e.stack ? '\n' + e.stack : ''));
  try { PropertiesService.getScriptProperties().setProperty('SYNC_ERROR', JSON.stringify({ at: new Date().toISOString(), msg: text, quota: quota })); } catch (x) {}
}

/**
 * Gmail History API ile son turdan beri değişen thread'ler.
 * changedIds: yeni mesaj gelen, readIds: okundu yapılan, unreadIds: okunmadı yapılan.
 * History noktası yoksa ya da çok eskiyse (404) null döner → tam taramaya düşülür.
 */
function gmailChanges_(startId) {
  if (!startId) return null;
  var changed = {}, read = {}, unread = {};
  var skip = function (labels) { return (labels || []).some(function (l) { return ['DRAFT', 'SPAM', 'TRASH', 'CHAT'].indexOf(l) >= 0; }); };
  var token = null, pages = 0;
  try {
    do {
      var hargs = { startHistoryId: startId, historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved'], maxResults: 500 };
      if (token) hargs.pageToken = token;
      var res = gapi_(2, function () { return Gmail.Users.History.list('me', hargs); });
      (res.history || []).forEach(function (h) {
        (h.messagesAdded || []).forEach(function (x) { if (x.message && !skip(x.message.labelIds)) changed[x.message.threadId] = true; });
        (h.labelsRemoved || []).forEach(function (x) { if (x.message && (x.labelIds || []).indexOf('UNREAD') >= 0) read[x.message.threadId] = true; });
        (h.labelsAdded || []).forEach(function (x) { if (x.message && (x.labelIds || []).indexOf('UNREAD') >= 0) unread[x.message.threadId] = true; });
      });
      token = res.nextPageToken;
      pages++;
    } while (token && pages < 20);
  } catch (e) {
    if (/404|not found|historyId/i.test(String(e))) return null;
    throw e;
  }
  return { changedIds: Object.keys(changed), readIds: Object.keys(read), unreadIds: Object.keys(unread) };
}

/** Yok sayılan marka: sheet'te kalır (tekrar işlenmez) ama board'da görünmez */
function ignoredRow_(prev, facts, cfg) {
  var row = prev ? JSON.parse(JSON.stringify(prev)) : {};
  Object.assign(row, {
    threadId: facts.threadId, subject: facts.subject, title: facts.subject,
    status: 'IGNORED', aiStatus: 'IGNORED', closed: true, closedBy: 'yok sayıldı',
    closedAt: new Date().toISOString(), priority: 5,
    participants: facts.participantsText, lastSender: facts.lastSenderName, lastSenderRole: facts.lastSenderRole,
    firstDate: facts.firstDate, lastDate: facts.lastDate, msgCount: facts.msgCount, lastMsgId: facts.lastMsgId,
    flags: facts.flags.join(','), link: gmailLink_(facts.threadId, cfg), updatedAt: new Date().toISOString()
  });
  return row;
}

// ============================================================
//  GEÇMİŞTEKİ OKUNMAMIŞ MAİLLERİ SHEET'E AKTARMA (tek sefer, parça parça)
//  Her thread bir kez okunur. Okunmuş olanlar AI'a gönderilmeden arşiv satırı olarak eklenir;
//  okunmamışlar AI kuyruğuna girer. İleride o thread'e yeni mesaj gelirse, AI thread'in
//  tamamını ilk kez okur ve bir "thread hafızası" oluşturur; sonraki mesajlarda sadece yeni
//  mesajlar + hafıza gönderilir (aynı mail tekrar tekrar okunmaz).
// ============================================================
function backfillStep() {
  var sp = PropertiesService.getScriptProperties();
  if (sp.getProperty('BF_DONE') === '1') { removeBackfillTrigger_(); return; }
  // Tarama 12 dakikadır çalışamadıysa önce ona yol ver
  var ls = sp.getProperty('LAST_SYNC');
  if (ls && Date.now() - new Date(ls).getTime() > 12 * 60000) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  var started = Date.now();
  try {
    var cfg = getConfig_();
    var db = loadDb_();
    db.guardSince = started;
    var floor = Date.now() - cfg.lookback * 86400000;
    var cursor = Number(sp.getProperty('BF_CURSOR') || Date.now() + 86400000);   // bu tarihten geriye doğru
    var offset = Number(sp.getProperty('BF_OFFSET') || 0);
    var added = 0;
    while (Date.now() - started < 120000) {
      if (cursor <= floor) { sp.setProperty('BF_DONE', '1'); removeBackfillTrigger_(); log_('INFO', 'Geçmiş aktarımı tamamlandı.'); break; }
      var from = Math.max(floor, cursor - cfg.bfWindow * 86400000);
      // Sadece okunmamış thread'ler (okunmuşlar zaten Done; sheet'i ve Gmail kotasını boşuna doldurmasın)
      var q = 'is:unread after:' + Math.floor(from / 1000) + ' before:' + Math.floor(cursor / 1000) + ' -in:spam -in:trash -in:drafts -in:chats';
      var threads = apiSearch_(q, 500);
      var cut = false;
      for (var i = 0; i < threads.length; i++) {
        var th = threads[i];
        if (db.byId[th.getId()]) continue;
        try { saveRow_(db, archiveRow_(th, cfg)); added++; }
        catch (e) { if (/too many times|limit|quota/i.test(String(e))) { throw e; } }
        if (Date.now() - started > 130000) { cut = true; break; }
      }
      if (cut) break;                     // aynı dilim bir sonraki turda devam eder (eklenenler atlanır)
      cursor = from; offset = 0;
    }
    sp.setProperty('BF_CURSOR', String(cursor));
    sp.setProperty('BF_OFFSET', String(offset));
    flushDb_(db);
    if (added) log_('INFO', 'Geçmiş aktarımı: ' + added + ' thread eklendi, ' + Utilities.formatDate(new Date(cursor), 'Europe/Istanbul', 'dd.MM.yyyy') + ' tarihine kadar geriye gidildi.');
  } catch (e) {
    log_('WARN', 'Geçmiş aktarımı durdu, sonra devam edecek: ' + e);
  } finally { lock.releaseLock(); }
}

function archiveRow_(th, cfg) {
  var msgs = th.getMessages();
  var first = msgs[0], last = msgs[msgs.length - 1];
  var lf = parseAddresses_(last.getFrom())[0] || { email: '', name: last.getFrom() };
  var ff = parseAddresses_(first.getFrom())[0] || { email: '', name: '' };
  var names = uniq_([ff.name || ff.email, lf.name || lf.email].concat(parseAddresses_(first.getTo()).slice(0, 6).map(function (a) { return a.name || a.email; }))).filter(String);
  var unread = th.isUnread();
  var snippet = cleanBody_(last.getPlainBody() || '').replace(/\s+/g, ' ').slice(0, 300);
  var row = {
    threadId: th.getId(), subject: th.getFirstMessageSubject() || '(konu yok)', title: th.getFirstMessageSubject() || '(konu yok)',
    brand: '', cm: 'Atanmamış', cmEmail: '', priority: 3, priorityReason: '',
    status: 'DONE', aiStatus: '', manualStatus: '',
    closed: !unread, closedAt: unread ? '' : last.getDate().toISOString(), closedBy: unread ? '' : 'arşiv',
    summary: snippet ? 'Son mesaj: ' + snippet : '', clientAsk: '', cmResponse: '', nextAction: '', suggestedReply: '',
    participants: names.join(', '), lastSender: lf.name || lf.email, lastSenderRole: roleOf_(lf.email, cfg),
    firstDate: first.getDate().toISOString(), lastDate: last.getDate().toISOString(),
    msgCount: unread ? '' : th.getMessageCount(),        // okunmamışsa AI kuyruğuna girer
    lastMsgId: last.getId(), addressedToMe: false, flags: 'ARCHIVE', link: gmailLink_(th.getId(), cfg),
    updatedAt: new Date().toISOString(), remindedAt: '', hasCm: false, memory: '', factsCache: ''
  };
  if (unread) row.status = 'IN_PROGRESS';
  return row;
}

function removeBackfillTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (tr) { if (tr.getHandlerFunction() === 'backfillStep') ScriptApp.deleteTrigger(tr); });
}

function backfillStatus() {
  var sp = PropertiesService.getScriptProperties(), cfg = getConfig_();
  var done = sp.getProperty('BF_DONE') === '1';
  var cur = Number(sp.getProperty('BF_CURSOR') || Date.now());
  var n = ss_().getSheetByName(SHEET_TASKS).getLastRow() - 1;
  SpreadsheetApp.getUi().alert(done ? ('Geçmiş aktarımı tamamlandı. Sheet\'te ' + n + ' thread var.')
    : ('Aktarım sürüyor: ' + Utilities.formatDate(new Date(cur), 'Europe/Istanbul', 'dd.MM.yyyy') + ' tarihine kadar gelindi (hedef: son ' + cfg.lookback + ' gün). Sheet\'te ' + n + ' thread var.'));
}

function closeReadThreads_(db, cfg) {
  var n = 0;
  var seen = {};
  db._labeledUnread = {};          // board label'ı olan okunmamış thread'ler (onarım adımı kullanır)
  boardLabelNames_().forEach(function (name) {
    var lid = labels_().byName[name];
    if (!lid) return;
    // DİKKAT: Gmail'de "-is:unread" MESAJ bazında çalışır; içinde tek bir okunmuş mesaj olan thread'i de
    // döndürür (son mesaj okunmamış olsa bile). Bu yüzden: label'daki tüm thread'ler − okunmamış olanlar.
    var unread = {};
    apiSearch_('is:unread', 3000, [lid]).forEach(function (t) { unread[t.getId()] = true; db._labeledUnread[t.getId()] = true; });
    apiSearch_('', 3000, [lid]).forEach(function (th) {
      var id = th.getId();
      if (seen[id]) return;
      seen[id] = true;
      if (unread[id]) return;
      var row = db.byId[id];
      if (row && (isTrue_(row.followUp) || isSticky_(row.manualStatus)) && !isTrue_(row.closed)) return;   // takipteki kart okunsa da açık kalır
      removeBoardLabels_(th);
      if (row && !isTrue_(row.closed)) {
        markClosed_(row, 'DONE', 'okundu');
        saveRow_(db, row);
      }
      n++;
    });
  });
  // Label'ı olmayan açık kayıtlar: tek tek kontrol pahalı → turda en fazla 25 kayıt / 30 sn
  var t0 = Date.now(), checked = 0;
  db.rows.forEach(function (row) {
    if (isTrue_(row.closed) || seen[row.threadId] || isTrue_(row.followUp) || isSticky_(row.manualStatus)) return;
    if (checked >= 10 || Date.now() - t0 > 20000) return;
    if (Date.now() - new Date(row.updatedAt).getTime() < 5 * 60000) return;
    checked++;
    try {
      var th = apiThread_(row.threadId);
      if (!th.exists()) { markClosed_(row, 'DONE', 'silindi'); saveRow_(db, row); return; }
      if (cfg.readCloses && !th.isUnread()) {
        removeBoardLabels_(th);
        markClosed_(row, 'DONE', 'okundu');
        saveRow_(db, row); n++;
      }
    } catch (e) { /* yoksay */ }
  });
  return n;
}

/** Açık / board'da görünen kartlarda recentMine boşsa Gmail'den sadece gönderen başlıklarını okuyup doldurur */
function backfillRecentMine_(db, cfg, started) {
  var limit = Date.now() - cfg.closedVisibleDays * 86400000;
  var todo = db.rows.filter(function (r) {
    if (r.status === 'IGNORED' || (r.recentMine !== '' && r.recentMine != null)) return false;
    return !isTrue_(r.closed) || new Date(r.closedAt || r.updatedAt).getTime() > limit;
  });
  for (var i = 0; i < todo.length; i++) {
    if (Date.now() - started > 240000) return false;
    var r = todo[i];
    try {
      var t = gapi_(10, function () { return Gmail.Users.Threads.get('me', r.threadId, { format: 'metadata', metadataHeaders: ['From'] }); });
      var msgs = (t.messages || []).filter(function (m) { return (m.labelIds || []).indexOf('DRAFT') < 0; }).slice(-3);
      r.recentMine = msgs.some(function (m) {
        var h = ((m.payload && m.payload.headers) || []).filter(function (x) { return lc_(x.name) === 'from'; })[0];
        return h && roleOf_((parseAddresses_(h.value)[0] || {}).email, cfg) === 'ME';
      });
    } catch (e) {
      if (/not found|404/i.test(String(e))) r.recentMine = false; else throw e;
    }
    r._dirty = true; db.dirty = true;
  }
  return true;
}

/** İş Tamamlandı'ya düşecek iş son olarak kullanıcının mailiyle kapandıysa (son mesaj onun) → doğrudan Done.
 *  İş Tamamlandı sütunu sadece başkalarının (CM/ekip/marka) kapattığı işler için kalır. */
function closeIfIFinished_(row, thread, cfg) {
  if (isTrue_(row.closed) || row.status !== 'COMPLETED' || row.lastSenderRole !== 'ME' || isSticky_(row.manualStatus) || isTrue_(row.followUp)) return false;
  try {
    var rm = boardLabelIds_().concat(['STARRED']);
    if (cfg.markReadOnClose) rm.push('UNREAD');
    if (thread) thread.modifyLabels([], rm);
  } catch (e) { if (!/not found|404/i.test(String(e))) log_('WARN', 'Done label temizliği: ' + e); }
  markClosed_(row, 'DONE', 'cevabınla tamamlandı');
  row.followUp = false;
  return true;
}

function markClosed_(row, status, by) {
  row.closed = true;
  row.status = status;
  row.closedAt = new Date().toISOString();
  row.closedBy = by;
  row.updatedAt = new Date().toISOString();
}

function reopenRow_(row, thread, cfg) {
  row.closed = false;
  row.closedAt = '';
  row.closedBy = '';
  row.manualStatus = '';
  row.status = row.aiStatus || 'IN_PROGRESS';
  applyStale_(row, cfg);
  row.updatedAt = new Date().toISOString();
  applyBoardLabels_(thread, row, cfg);
}

/**
 * Tam kontrolün onarım adımı. Gmail'deki tüm okunmamış thread'leri (lookback içinde) sayfa sayfa gezer:
 *  - sheet'te yok → bu turda işlenir; tur kapasitesi doluysa geçici kayıt + label açılır, AI sonra sınıflar
 *  - sheet'te kapalı (yanlışlıkla kapanmış) → yeniden açılır, label'ı geri gelir
 *  - sheet'te açık ama label'ı yok → label'ı yeniden atanır
 * closeReadThreads_ önce çalışmış olmalı (db._labeledUnread).
 * Süre dolarsa complete=false döner; LAST_FULL_CHECK ilerlemez, sonraki tur devam eder.
 */
function repairUnread_(db, cfg, base, seenIds, threads, started) {
  var res = { unread: 0, reopened: 0, relabeled: 0, added: 0, complete: true };
  var labeled = db._labeledUnread || {};
  var list = apiSearch_('is:unread newer_than:' + cfg.lookback + 'd' + base, 5000);
  res.unread = list.length;
  for (var i = 0; i < list.length; i++) {
    if (Date.now() - started > 150000) { res.complete = false; break; }
    var t = list[i], id = t.getId(), row = db.byId[id];
    if (seenIds[id]) continue;
    try {
      if (!row) {
        seenIds[id] = true;
        if (threads.length < cfg.maxPerRun) { threads.push(t); continue; }
        var ar = archiveRow_(t, cfg);            // msgCount '' → AI kuyruğunda, sonraki turlarda sınıflanır
        saveRow_(db, ar);
        applyBoardLabels_(t, ar, cfg);
        res.added++;
        continue;
      }
      if (row.status === 'IGNORED') continue;
      if (isTrue_(row.closed)) {
        reopenRow_(row, t, cfg); saveRow_(db, row); res.reopened++;
      } else if (!labeled[id]) {
        applyBoardLabels_(t, row, cfg); res.relabeled++;
      }
    } catch (e) {
      if (/too many times|quota|rate limit/i.test(String(e))) throw e;
      log_('WARN', 'Onarım: ' + id + ' düzeltilemedi: ' + e);
    }
  }
  // Ters yön: sheet'te açık görünen ama Gmail'de artık okunmamış OLMAYAN kartlar → Done (label'ları kaldır).
  // Sadece okunmamış listesi eksiksizse (5000 sınırına takılmadıysa) ve tur tamamlandıysa.
  res.closedRead = 0;
  if (cfg.readCloses && res.complete && list.length < 5000) {
    var unreadSet = {}, floor = Date.now() - cfg.lookback * 86400000;
    list.forEach(function (t) { unreadSet[t.getId()] = true; });
    var boardIds = boardLabelIds_();
    db.rows.forEach(function (r) {
      if (Date.now() - started > 200000) return;
      if (isTrue_(r.closed) || isTrue_(r.followUp) || isSticky_(r.manualStatus) || r.status === 'IGNORED' || unreadSet[r.threadId]) return;
      if (new Date(r.lastDate).getTime() < floor) return;                       // lookback dışı: bilinmiyor, dokunma
      if (Date.now() - new Date(r.updatedAt).getTime() < 5 * 60000) return;     // az önce işlenmiş
      try { apiThread_(r.threadId).modifyLabels([], boardIds); } catch (e) { if (!/not found|404/i.test(String(e))) return; }
      markClosed_(r, 'DONE', 'okundu'); saveRow_(db, r); res.closedRead++;
    });
  }
  return res;
}

// ============================================================
//  3+ İŞ GÜNÜ
// ============================================================
/** lastDate'ten bu yana geçen iş günü (Pzt–Cuma, İstanbul saati) */
/**
 * Mail kaç iş günüdür bekliyor? Geldiği günden SONRA geçen iş günleri sayılır (geldiği gün 0).
 * 18:00'den sonra ya da hafta sonu gelen mail bir sonraki iş günü sabahı gelmiş sayılır.
 * Bugün, mesai başladıktan (09:00) sonra sayılır; gece yarısı "bir gün daha geçti" sayılmaz. Hafta sonu sayılmaz.
 * Örn. Pazartesi 09:28 gelen mail Çarşamba 2. iş günündedir, Perşembe 09:00'dan itibaren 3.
 */
function workDaysWaiting_(iso, now) {
  if (!iso) return 0;
  now = now || new Date();
  var tz = 'Europe/Istanbul', f = function (x, p) { return Utilities.formatDate(x, tz, p); };
  var c = new Date(iso);
  if (isNaN(c)) return 0;
  if (Number(f(c, 'H')) >= 18) c = new Date(c.getTime() + 86400000);
  while (Number(f(c, 'u')) > 5) c = new Date(c.getTime() + 86400000);     // hafta sonu → Pazartesi
  c = new Date(c.getTime() + 86400000);                                     // geldiği gün sayılmaz
  var end = Number(f(now, 'H')) >= 9 ? f(now, 'yyyyMMdd') : f(new Date(now.getTime() - 86400000), 'yyyyMMdd'), n = 0;
  while (f(c, 'yyyyMMdd') <= end) { if (Number(f(c, 'u')) <= 5) n++; c = new Date(c.getTime() + 86400000); }
  return n;
}

function businessDaysSince_(iso, now) {
  if (!iso) return 0;
  var d = new Date(iso);
  now = now || new Date();
  var n = 0;
  var cursor = new Date(d.getTime() + 86400000);
  while (cursor <= now) {
    var wd = Number(Utilities.formatDate(cursor, 'Europe/Istanbul', 'u')); // 1=Pzt … 7=Paz
    if (wd <= 5) n++;
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return n;
}

/**
 * Takip kuralları (her taramada ve board açılırken çalışır). Değişiklik olduysa true döner.
 *  - Hatırlatma yapılmış kart (followUp): CM, hatırlatmadan sonra REMIND_WAIT_BUSINESS_DAYS iş günü içinde
 *    dönmezse → tekrar 3+ İş Günü Bekleyen.
 *  - Normal kart: CM Cevabı Bekleniyor / Devam Ediyor durumunda STALE_BUSINESS_DAYS'ten uzun hareketsizse
 *    → 3+ İş Günü Bekleyen. AMA son sözü CM/ekip söylediyse ve "yapıyoruz / yapacağız / düzenliyoruz" gibi
 *    işi üstlendiyse → iş muhtemelen yapıldı, hatırlatma yerine İş Tamamlandı.
 */
function applyStale_(row, cfg) {
  if (isTrue_(row.closed)) return false;
  if (/(^|,)JIRA(,|$)/.test(String(row.flags || ''))) return false;   // Jira bildirimleri bekleme/hatırlatma akışına girmez (aşama Jira'dan gelir)
  var before = row.status;
  // Kural: "3+ İş Günü Bekleyen" sütununda SADECE son mesajın üzerinden 3+ iş günü geçmiş kartlar durur.
  var staleNow = workDaysWaiting_(row.lastDate) >= cfg.staleDays;
  var fallback = STALE_SOURCE.indexOf(row.aiStatus) >= 0 ? row.aiStatus : 'IN_PROGRESS';
  if (isTrue_(row.followUp)) {
    if (row.status === 'REMINDED' && staleNow && businessDaysSince_(row.remindedAt || row.lastDate) >= cfg.remindWait) row.status = 'STALE';
    else if (row.status === 'STALE' && !staleNow) {
      if (row.remindedAt) row.status = 'REMINDED';                    // hatırlatma yapılmış, süre henüz dolmadı
      else { row.status = fallback; row.followUp = false; }           // elle bekleyene atılmış ama 3 iş günü dolmamış
    }
    return row.status !== before;
  }
  if (row.manualStatus) return false;
  // İleri tarihli talep ("2 Ekim'de rapor rica edeceğim"): tarihe kadar bekleyen sayılmaz.
  // Tarih gelince: son mesajdan bu yana 3+ iş günü geçtiyse 3+ İş Günü Bekleyen, geçmediyse (CM cevap verdiyse) İş Devam Ediyor.
  var due = dueOf_(row);
  if (due && STALE_SOURCE.indexOf(row.aiStatus) >= 0) {
    var today = Utilities.formatDate(new Date(), 'Europe/Istanbul', 'yyyy-MM-dd');
    var answered = ['CM', 'INTERNAL', 'ME'].indexOf(row.lastSenderRole) >= 0;
    var wd = (today >= due && staleNow) ? 'STALE' : (answered ? 'IN_PROGRESS' : row.aiStatus);
    if (String(row.flags || '').indexOf('AUTO_COMPLETED') >= 0) row.flags = String(row.flags).split(',').filter(function (f) { return f && f !== 'AUTO_COMPLETED'; }).join(',');
    if (row.status !== wd) { row.status = wd; return true; }
    return row.status !== before;
  }
  // Markada Bekleyen iş CLIENT_STALE_DAYS (5) iş günü cevapsız kalırsa → "Markada 5+ İş Günü"
  var clientStale = workDaysWaiting_(row.lastDate) >= (cfg.clientStaleDays || 5);
  if (row.aiStatus === 'WAITING_CLIENT') {
    var wc = clientStale ? 'CLIENT_STALE' : 'WAITING_CLIENT';
    if (row.status !== wc) { row.status = wc; return true; }
    return false;
  }
  if (STALE_SOURCE.indexOf(row.aiStatus) < 0) {
    if (row.status === 'STALE' || row.status === 'CLIENT_STALE') { row.status = row.aiStatus || 'IN_PROGRESS'; return true; }   // eski/hatalı bekleyen işareti
    return false;
  }
  var stale = staleNow;   // geldiği gün dahil 3. iş günü   // "3+ iş günü" = 3 dahil
  var want = row.aiStatus;
  if (stale) {
    if (cmCommitted_(row)) {
      want = 'COMPLETED';
      if (String(row.flags || '').indexOf('AUTO_COMPLETED') < 0) row.flags = (row.flags ? row.flags + ',' : '') + 'AUTO_COMPLETED';
      row.priorityReason = 'CM işi üstlenmişti ("yapıyoruz" vb.), ' + cfg.staleDays + '+ iş günü geçti → tamamlanmış kabul edildi';
    } else if (String(row.flags || '').indexOf('LAST_TO_CLIENT') >= 0 && ['CM', 'INTERNAL', 'ME'].indexOf(row.lastSenderRole) >= 0 && !(['CM', 'INTERNAL'].indexOf(row.lastSenderRole) >= 0 && (pendingReply_(row) || askedInternal_(cacheOf_(row).lastBody, cacheOf_(row), cfg)))) {
      // Son sözü biz söyledik (markaya ya da dış tarafa: Google/Meta ekibi, partner…) ve üstlenilmiş bir iş yok
      // → top dışarıda. Bu hatırlatılacak bir gecikme değil, Markada Bekleyen.
      var lcBody = cacheOf_(row).lastBody;
      want = (!lcBody || clientAsked_(lcBody) || String(row.flags || '').indexOf('CLIENT_ASKED') >= 0) ? 'WAITING_CLIENT' : 'STALE';   // markadan açıkça bir şey istenmediyse top bizde
    } else want = 'STALE';
  }
  if (want === 'WAITING_CLIENT' && clientStale) want = 'CLIENT_STALE';
  if (want !== 'COMPLETED' && String(row.flags || '').indexOf('AUTO_COMPLETED') >= 0) {
    // Eskiden yanlışlıkla "tamamlandı" sayılmış (ör. CM sadece "dönüş yapacağım" demiş) → işareti kaldır
    row.flags = String(row.flags).split(',').filter(function (f) { return f && f !== 'AUTO_COMPLETED'; }).join(',');
    if (/^CM işi üstlenmişti/.test(row.priorityReason || '')) row.priorityReason = 'CM dönüş yapacağını söyledi, ' + cfg.staleDays + '+ iş günüdür dönmedi';
    if (row.status === want) return true;
  }
  if (row.status !== want) { row.status = want; return true; }
  return false;
}
function foldTr_(x) { return String(x || '').toLowerCase().replace(/i̇/g, 'i').replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c'); }
function bodyHead_(body) { return String(body || '').split(/\n\s*(sevgiler|saygılar|saygılarımla|iyi çalışmalar|best|regards|kind regards)\s*,?\s*\n/i)[0]; }
/**
 * Son mesaj (CM/ekip) BIZ içinden birine soru/istek mi yöneltiyor? ("+Can bize destek olabilir misin?")
 * → top BIZ'de, iş devam ediyor (ne tamamlandı ne markada bekliyor).
 */
function askedInternal_(body, cache, cfg) {
  var head = bodyHead_(body);
  if (!head || !cache || !cache.participants) return false;
  if (!/\?/.test(head) && !/\+\s?[A-ZÇĞİÖŞÜ]/.test(head)) return false;
  var sender = cache.last && cache.last.email, fold = foldTr_(head);
  return Object.keys(cache.participants).some(function (em) {
    if (em === sender) return false;
    var r = roleOf_(em, cfg); if (r !== 'INTERNAL' && r !== 'CM') return false;
    var nm = foldTr_(String(cache.participants[em].name || em.split('@')[0]).trim().split(/[\s._-]+/)[0]).replace(/[^a-z]/g, '');
    if (nm.length < 3) return false;
    return new RegExp('(^|[^a-z])' + nm + '([^a-z]|$)').test(fold);
  });
}
// Markaya giden son BIZ mesajı markadan AÇIKÇA bir şey istiyor mu? (soru, onay, geri bildirim, materyal, karar…)
// Sadece teslim / bilgilendirme ("kurulumları tamamladık, preview linkleri aşağıda") → markadan beklenen bir şey yok.
var CLIENT_ASK_RE = /(\?|onay(ınız|ınızı|ınıza|ınızla|lar mısınız|layabilir|laman[ıi]z|layınız)|teyit(iniz|inizi|inize| eder misiniz| edebilir| etmeniz)|dönüş(ünüz|ünüzü|ünüze|leriniz|lerinizi|lerinize)|geri ?bildirim(iniz|inizi|leriniz|lerinizi)|değerlendirme(niz|nizi|leriniz|lerinizi)|görüş(ünüz|ünüzü|leriniz|lerinizi)|yorum(unuz|unuzu|lar[ıi]n[ıi]z)|rica ederi[mz]|rica ediyoru[mz]|bekliyoru[mz]|bekliyor olaca[ğg][ıi]|bekleriz|bekliyor olacağım|(a|e)bilir misiniz|(ı|i|u|ü)r m[ıi]s[ıi]n[ıi]z|m(a|e)n[ıi]z[ıi]? (rica|bekl|önemli|gerek)|(ediniz|eyiniz|ayınız|iletiniz|gönderiniz|paylaşınız|bildiriniz|sağlayınız)\b|ihtiyac[ıi]m[ıi]z (var|bulunmaktad[ıi]r|olacak)|ihtiyaç duyulmaktad[ıi]r|gerekmektedir|gerekiyor|gerekli (olan )?(belge|doküman|evrak|bilgi|materyal|görsel|dosya)|talep (ediyor|etmektedir|edilmektedir|ediliyor|ettiler|etti)|istenmektedir|istiyor(lar)?\b|isteniyor|beklenmektedir|bekleniyor|(iletilmesi|gönderilmesi|paylaşılmas[ıi]|sağlanmas[ıi]|yüklenmesi|doldurulmas[ıi]|imzalanmas[ıi]|onaylanmas[ıi])|belge(ler)?(in)?i? (ilet|gönder|paylaş|sağla)|let (us|me) know|please (confirm|approve|review|share|send|check|advise|provide)|could you|can you|would you|kindly|your (feedback|approval|confirmation|input|thoughts))/i;
function clientAsked_(body) {
  var head = bodyHead_(body).replace(/(https?:\/\/|www\.)\S+/gi, ' ');
  return CLIENT_ASK_RE.test(head);
}
/** AI'ın teslim tarihi geçerli mi? Sadece markanın istediği ya da BIZ'in söz verdiği teslim tarihleri (bilgi/uyarı tarihleri değil). */
function validDue_(ai) { return /^\d{4}-\d{2}-\d{2}$/.test(String(ai && ai.due_date || '')) && /^(CLIENT_REQUEST|BIZ_PROMISE)$/.test(String(ai.due_source || '').toUpperCase()); }
/** flags içindeki DUE:yyyy-MM-dd (AI'ın bulduğu ileri teslim tarihi) */
function dueOf_(row) { var m = String(row.flags || '').match(/(?:^|,)DUE:(\d{4}-\d{2}-\d{2})/); return m ? m[1] : ''; }
/**
 * Jira bildirim thread'i: her mail bir olay ("<Kişi> added a comment on a work item …").
 * needsMe: son olay başkasının yorumu VE (yorumda @ben geçiyor YA DA son 3 yorumdan biri benim).
 */
function jiraInfo_(all, cfg) {
  var myNames = [cfg.MY_NAME].concat(cfg.aliases || []).map(function (n) { return foldTr_(String(n || '').trim()); }).filter(function (n) { return n.split(/\s+/).length >= 2; });
  var first = foldTr_((cfg.MY_NAME || '').split(/\s+/)[0] || '');
  var isMe = function (actor) { var a = foldTr_(actor).replace(/\(jira\)/, '').trim(); return !!a && myNames.some(function (n) { return a === n; }); };
  var ev = all.slice(-15).map(function (m) {
    var body = String(m.getPlainBody() || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    var mm = body.match(/^(.{2,60}?)\s+(added a comment|edited a comment|commented|mentioned you|updated|created|changed|resolved|assigned|yorum ekledi|yorumu düzenledi|güncelledi|oluşturdu|sizden bahsetti)\b/i);
    var name = mm ? mm[1].trim() : String((parseAddresses_(m.getFrom())[0] || {}).name || '').replace(/\(jira\)/i, '').trim();
    var verb = mm ? mm[2].toLowerCase() : '';
    var fb = foldTr_(body);
    var mention = /mentioned you|sizden bahsetti/i.test(body) || myNames.some(function (n) { return fb.indexOf('@' + n) >= 0; }) || (first && fb.indexOf('@' + first + ' ') >= 0);
    return { actor: name, comment: /comment|yorum|mentioned|bahsetti/.test(verb), mine: isMe(name), mention: mention };
  });
  var last = ev[ev.length - 1] || {};
  var comments = ev.filter(function (e) { return e.comment; });
  var myRecent = comments.slice(-3).some(function (e) { return e.mine; });
  var mention = !last.mine && last.mention;
  var needsMe = !last.mine && (mention || (last.comment && myRecent));
  return { needsMe: needsMe, mention: !!mention, myRecent: myRecent, lastActor: last.actor || '', lastMine: !!last.mine, lastComment: !!last.comment };
}
function cacheOf_(row) { try { return JSON.parse(row.factsCache || '{}'); } catch (e) { return {}; } }

/** Son CM mesajı sadece "dönüş yapacağım" türünde bir söz mü? */
function pendingReply_(row) {
  var last = '';
  try { var c = JSON.parse(row.factsCache || '{}'); last = String(c.lastBody || ''); } catch (e) {}
  return !!last && PENDING_REPLY_RE.test(last);
}

// "İşi yapacağız" (talep edilen aksiyonu üstlenme) → 3+ iş günü sessizlikte iş tamamlanmış sayılır.
// Sadece somut aksiyon fiilleri; "bakacağız / kontrol edeceğiz / ileteceğiz" gibi ifadeler dönüş sözüdür, üstlenme değil.
var COMMIT_RE = /(yap[ıi]yor olaca[ğg][ıi]z|yapaca[ğg][ıi]z|yap[ıi]yoruz|düzenl(ey|iy)ece[ğg]iz|düzenliyoruz|düzenlemeleri (yap|gerçekleştir)|aksiyon al[ıi]yoruz|aksiyon alaca[ğg][ıi]z|aksiyonlar[ıi] al[ıi]yoruz|hallediyoruz|halledece[ğg]iz|ekliyoruz|ekleyece[ğg]iz|güncelliyoruz|güncelleyece[ğg]iz|yay[ıi]na al[ıi]yoruz|yay[ıi]na alaca[ğg][ıi]z|kurulum(u|lar[ıi])? (yap|tamamla)[ıi]yoruz|tamamlayaca[ğg][ıi]z|we will (do|update|implement|set up|launch)|working on it)/i;
// "Dönüş yapacağım / inceleyip döneceğim / bilgi vereceğim / teşekkürler" → sadece cevap sözü; iş CM'de bekliyor (3+ iş günü bekleyen olmalı)
var PENDING_REPLY_RE = /(dön(üş|us)\s*(yapaca|sağlaya|saglaya|yap[ıi]yor olaca|verece|iletece)|dönece[ğg]|donece[gğ]|dönüyor olaca|dönüş sağlanacak|geri dönece|geri dönüş (yapaca|sağlaya)|bilgi (verece|iletece|paylaşaca)|(inceleyip|kontrol edip|bak[ıi]p|araştırıp|değerlendirip|sorup|teyit edip|iletip)|(kontrol|inceleme|değerlendirme) (edece|yapaca|sonras)|bakaca[ğg][ıi]m|bakaca[ğg][ıi]z|kontrol edece|iletece[ğg][ıi]m|iletece[ğg]iz|get back to you|will (revert|let you know|check|look into)|revert (back )?to you)/i;
// Sadece teşekkür edip konuyu kapatan kısa mesaj ("Bilgilendirme için teşekkürler") → iş kapanmış sayılır
var THANKS_RE = /(teşekkür|tesekkur|teşekkurler|sağ ?ol|eline sağlık|elinize sağlık|thanks|thank you|rica ederiz|rica ederim|harika|süper|tamamdır|anlaşıldı|not ald[ıi]k|noted)/i;

/** Son CM/ekip mesajı talep edilen işi üstleniyor mu? ("yapacağız" → evet; "dönüş yapacağım" → hayır) */
function cmCommitted_(row) {
  if (['CM', 'INTERNAL'].indexOf(row.lastSenderRole) < 0) return false;
  var last = '';
  try { var c = JSON.parse(row.factsCache || '{}'); last = String(c.lastBody || c.lastOtherBody || ''); } catch (e) {}
  // Son mesajda sadece dönüş sözü varsa (AI "üstlendi" demiş olsa bile) iş tamamlanmış sayılmaz
  if (last && PENDING_REPLY_RE.test(last) && !COMMIT_RE.test(last.replace(PENDING_REPLY_RE, ''))) return false;
  if (!last && PENDING_REPLY_RE.test(String(row.cmResponse || '') + ' ' + String(row.nextAction || ''))) return false;
  if (last && /\?/.test(bodyHead_(last))) return false;       // son mesaj bir soru/istek → cevap bekleniyor, iş kapanmadı
  if (String(row.flags || '').indexOf('CM_COMMITTED') >= 0) return true;
  if (last && COMMIT_RE.test(last)) return true;
  if (last && thanksOnly_(last)) return true;          // "teşekkürler" deyip geçmiş, dönüş sözü yok → konu kapandı
  return false;
}
/** Mesaj sadece bir teşekkür/onay mı? (selamlama ve kapanış hariç kısa, soru yok, dönüş sözü yok) */
function thanksOnly_(body) {
  var t = String(body || '').replace(/\r/g, '');
  t = t.split(/\n\s*(sevgiler|saygılar|saygılarımla|iyi çalışmalar|best|regards|thanks,)\s*,?\s*\n/i)[0];    // kapanış ve imza sonrası
  t = t.replace(/^\s*[^\n]{0,40}(selam|merhaba|merhabalar|selamlar|hi|hello)[^\n]{0,20}\n/i, '');          // selamlama satırı
  t = t.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 220 || /\?/.test(t)) return false;
  if (PENDING_REPLY_RE.test(t) || COMMIT_RE.test(t)) return false;
  return THANKS_RE.test(t);
}

// ============================================================
//  THREAD ANALİZİ
// ============================================================
var MY_REPLY_EFFECT_ = { ASKED_CLIENT: 'WAITING_CLIENT', DELEGATED: 'WAITING_CM', TOOK_OVER: 'IN_PROGRESS', CLOSED: 'COMPLETED' };
var MY_REPLY_REASON_ = { ASKED_CLIENT: 'Cevabında markadan bir şey istedin', DELEGATED: 'Cevabında işi CM\'e/ekibe devrettin', TOOK_OVER: 'Cevabında işi üstlendin', CLOSED: 'Cevabınla konu kapandı' };
/**
 * Jira kartının aşaması (Jira API'den):
 *  TODO      → JIRA       ekip henüz almadı (durum "To Do" kategorisinde ve ekipten yorum yok)
 *  WIP       → JIRA_WIP   ekip çalışıyor (durum "In Progress" kategorisinde ya da ekipten biri yorum yazdı)
 *  TEAM_DONE → JIRA_DONE  ekip ya da CM "Done" kategorisine aldı
 *  MY_DONE   → kart kapanır (DONE), task'i kullanıcı Done'a aldı
 * Ekip = kullanıcı ve CM'ler dışındaki Jira kullanıcıları. Jira bağlı değilse null.
 */
var JIRA_STAGE_STATUS_ = { ME: 'MY_REPLY', US: 'WAITING_CM', TODO: 'JIRA', WIP: 'JIRA_WIP', TEAM_DONE: 'JIRA_DONE', MY_DONE: 'DONE' };
/** Jira durum adı → aşama. "To Do" kategorisinde olup aslında ekibin yürüttüğü ya da bizi beklediği durumlar.
 *  Ayarlar > JIRA_STATUS_MAP ile eklenebilir/değiştirilebilir (ör. "MT'de Bekliyor=US, Devam Eden Yayın=WIP, Recurring=WIP"). */
var JIRA_STATUS_MAP_DEFAULT_ = "MT'de Bekliyor=US, Devam Eden Yayın=WIP, Recurring=WIP, In Review=WIP";
function jiraStatusMap_() {
  var out = {};
  [JIRA_STATUS_MAP_DEFAULT_, String(getConfig_().JIRA_STATUS_MAP || '')].forEach(function (src) {
    src.split(',').forEach(function (pair) { var kv = pair.split('='); if (kv.length === 2 && kv[0].trim()) out[foldTr_(kv[0].trim())] = kv[1].trim().toUpperCase(); });
  });
  return out;
}
var JIRA_STAGE_MEMO_ = {};
function jiraStageOf_(key, fresh) {
  key = String(key || '').toUpperCase(); if (!key || !jiraCreds_()) return null;
  if (!fresh && JIRA_STAGE_MEMO_[key]) return JIRA_STAGE_MEMO_[key];
  var i = jiraFetch_('get', '/rest/api/3/issue/' + key + '?fields=status,comment,summary&expand=changelog', null, true);
  if (!i || i._err) return null;
  var f = i.fields || {}, st = f.status || {}, cat = (st.statusCategory && st.statusCategory.key) || '';
  var me = {}; try { me = JSON.parse(PropertiesService.getUserProperties().getProperty('JIRA_ACCOUNT') || '{}'); } catch (e) {}
  var cmList = (getConfig_().cms || []).map(function (c) { return c.name || ''; });
  var cms = cmList.map(foldTr_);
  var isMe = function (a) { return !!(a && ((me.id && a.accountId === me.id) || (me.name && a.displayName === me.name))); };
  var isCm = function (a) { return !!(a && cms.indexOf(foldTr_(a.displayName || '')) >= 0); };
  var out = { key: key, status: st.name || '', stage: 'TODO', by: '' };
  var done = function (stage, by) { out.stage = stage; if (by) out.by = by; JIRA_STAGE_MEMO_[key] = out; return out; };
  var cs = ((f.comment && f.comment.comments) || []);
  // Benim son hareketim: son yorumum ya da task'te yaptığım herhangi bir değişiklik (durum, açıklama, atama…)
  var myLast = 0;
  cs.forEach(function (c) { if (isMe(c.author)) myLast = Math.max(myLast, new Date(c.created).getTime() || 0); });
  ((i.changelog && i.changelog.histories) || []).forEach(function (h) { if (isMe(h.author)) myLast = Math.max(myLast, new Date(h.created).getTime() || 0); });
  var after = cs.filter(function (c) { return c.author && c.author.accountType !== 'app' && !isMe(c.author) && (new Date(c.created).getTime() || 0) > myLast; });
  // 1) Task Done'daysa (kategori 'done') sütunu Tamamlandı: kapatırken beni etiketlemek bilgi vermektir, cevap beklenmez.
  //    Kim kapattı: ben → Done (kapanır), ekip → Jira · Ekip Tamamladı
  if (cat === 'done') {
    var by = null;
    ((i.changelog && i.changelog.histories) || []).slice().sort(function (a, b) { return new Date(a.created) - new Date(b.created); }).forEach(function (h) {
      (h.items || []).forEach(function (it) { if (it.field === 'status' && it.toString === st.name) by = h.author; });
    });
    return done(isMe(by) ? 'MY_DONE' : 'TEAM_DONE', (by && by.displayName) || '');
  }
  // 2) Benim son hareketimden sonra biri beni etiketlediyse → Hemen Cevapla
  var meRe = me.name ? new RegExp('@' + String(me.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  // Bahsetme GÜNCEL olmalı: son 3 yorumdan biri olmalı VE ondan sonra konuşma başka biriyle (ör. CM cevapladı, ekip başkasına yazdı) sürmemiş olmalı.
  // Ör. 1 ay önce "@Deniz @Elif LP'yi rica edebilir miyiz?" → sonra Elif cevap verip konuşmayı sürdürdüyse bu artık senden beklenmiyor.
  var mentionsMe = function (c) { var raw = JSON.stringify(c.body || ''); return (me.id && raw.indexOf('"' + me.id + '"') >= 0) || (meRe && meRe.test(adfToText_(c.body))); };
  var ask = [];
  var tail = cs.slice(-3);
  for (var ti = 0; ti < tail.length; ti++) {
    var tc = tail[ti];
    if (!tc.author || isMe(tc.author) || (new Date(tc.created).getTime() || 0) <= myLast || !mentionsMe(tc)) continue;
    var movedOn = tail.slice(ti + 1).some(function (n) { return n.author && n.author.accountId !== tc.author.accountId; });
    if (!movedOn) ask.push(tc);
  }
  if (ask.length) return done('ME', ask[ask.length - 1].author.displayName || '');
  // 3) Benden sonra yazılan son yorumu OKU: bana mı soruyor, CM'e mi, ekip yapıyor mu, bitirdi mi
  var cls = after.length ? jiraCommentClass_(after[after.length - 1], f.summary || '', st.name || '', me.name || '', cmList, isCm(after[after.length - 1].author)) : '';
  var lastBy = after.length ? (after[after.length - 1].author.displayName || '') : '';
  if (cls === 'ME') return done('ME', lastBy);
  if (cls === 'CM') return done('US', lastBy);
  if (cls === 'DONE') return done('TEAM_DONE', lastBy);
  // 4) Durum adı / kategorisi
  var mapped = jiraStatusMap_()[foldTr_(st.name || '')] || '';
  if (mapped === 'US') return done('US');
  if (mapped === 'WIP' || mapped === 'TODO' || mapped === 'TEAM_DONE') return done(mapped);
  if (cat === 'indeterminate') return done('WIP', lastBy);
  if (cls === 'WIP') return done('WIP', lastBy);
  return done('TODO');
}
/**
 * Ekipten/CM'den gelen son yorumu sınıfla (AI, sonuç yorum id'sine göre saklanır; AI yoksa kelime kuralı):
 *  ME   → kullanıcıya soru/onay/karar/bilgi talebi ya da markadan bir şey istenmesi gerekiyor
 *  CM   → Client Manager'a soru/talep
 *  DONE → ekip işi bitirdiğini bildiriyor (yayına aldık, ekledik, tamamlandı)
 *  WIP  → ekip üzerinde çalışıyor / aldı / bilgi veriyor
 *  TEAM → (CM yazdıysa) ekipten bir şey istiyor → ekip henüz almadı
 */
function jiraCommentClass_(c, summary, status, myName, cmList, byCm) {
  var id = String(c.id || ''), up = PropertiesService.getUserProperties(), memo = {};
  try { memo = JSON.parse(up.getProperty('JIRA_CMT_CLS') || '{}'); } catch (e) {}
  if (id && memo[id]) return memo[id];
  var text = adfToText_(c.body).replace(/\s+/g, ' ').trim().slice(0, 2500), who = (c.author && c.author.displayName) || '?';
  var when = c.created ? Utilities.formatDate(new Date(c.created), 'Europe/Istanbul', 'dd.MM.yyyy HH:mm') : '';
  var cls = '';
  try {
    var a = safeJson_(callGemini_([
      'Bir ajansta Jira task\'ine gelen SON yorumu sınıflandır. Kullanıcı: ' + (myName || 'kullanıcı') + ' (Client Director). Client Manager(lar): ' + (cmList.join(', ') || '—') + '. Yorumu yazan: ' + who + (byCm ? ' (Client Manager)' : ' (uygulama ekibi)') + '.',
      'Task: ' + summary + ' | Durum: ' + status,
      'YORUM (' + when + ', şu an ' + nowStr_() + '): ' + text,
      'Yorum ne istiyor? Tek bir değer seç:',
      'ME = ' + (myName || 'kullanıcı') + '\'dan bir şey bekleniyor: ona soru, onay, karar ya da bilgi talebi; ya da markadan (müşteriden) bir şey istenmesi gerekiyor (materyal, onay, teyit).',
      'CM = Client Manager\'a soru ya da talep (adı geçiyor ya da ona hitap ediliyor).',
      'DONE = ekip işi bitirdiğini bildiriyor (yayına aldık, ekledik, güncelledik, tamamlandı) ve kimseden bir şey istemiyor.',
      'WIP = ekip işi aldı / üzerinde çalışıyor / ara bilgi veriyor ("bakıyoruz", "yarın kuruyoruz"), kimseden bir şey istemiyor.',
      'TEAM = yorumu Client Manager yazdı ve ekipten bir şey istiyor.',
      'Bir yorum hem bitirdiğini söyleyip hem soru soruyorsa soruyu esas al (ME ya da CM).',
      'SADECE şu JSON\'u döndür: {"cls": "ME|CM|DONE|WIP|TEAM"}'
    ].join('\n'), getConfig_()));
    cls = String(a.cls || '').toUpperCase().trim();
  } catch (e) { try { log_('WARN', 'Jira yorumu sınıflanamadı: ' + e); } catch (x) {} }
  if (['ME', 'CM', 'DONE', 'WIP', 'TEAM'].indexOf(cls) < 0) {
    var ft = foldTr_(text), first = foldTr_(String(myName || '').split(/\s+/)[0] || '');
    var cmHit = cmList.some(function (n) { var fn = foldTr_(String(n).split(/\s+/)[0] || ''); return fn && ft.indexOf(fn) >= 0; });
    if (byCm) cls = 'TEAM';
    else if (/\?/.test(text) && first && ft.indexOf(first) >= 0) cls = 'ME';
    else if (/\?/.test(text) && cmHit) cls = 'CM';
    else if (/(tamamla|yayina al|ekledik|guncelledik|yapildi|kapattik|duzenledik)/.test(ft) && !/\?/.test(text)) cls = 'DONE';
    else cls = 'WIP';
  }
  if (id) {
    memo[id] = cls;
    var ks = Object.keys(memo); if (ks.length > 400) ks.slice(0, ks.length - 400).forEach(function (k) { delete memo[k]; });
    try { up.setProperty('JIRA_CMT_CLS', JSON.stringify(memo)); } catch (e) {}
  }
  return cls;
}
function jiraStageReason_(js) {
  if (!js) return 'Jira bildirimi';
  if (js.stage === 'ME') return 'Jira\'da senden bahsedildi (' + (js.by || '?') + ')';
  if (js.stage === 'US') return 'Jira: ' + (js.by ? js.by + ' ' : 'ekip ') + 'CM\'den dönüş bekliyor (' + js.status + ')';
  if (js.stage === 'TEAM_DONE') return 'Jira: ' + (js.by || 'ekip') + ' tamamladı (' + js.status + ')';
  if (js.stage === 'MY_DONE') return 'Jira: task\'i sen Done\'a aldın (' + js.status + ')';
  if (js.stage === 'WIP') return 'Jira: ekip üzerinde çalışıyor (' + js.status + (js.by ? ', son yorum ' + js.by : '') + ')';
  return 'Jira: ekip henüz almadı (' + js.status + ')';
}
/** Kartın Jira aşamasını satıra uygula (MY_DONE → kart kapanır). manuel/sabit durumlara dokunmaz. */
function applyJiraStage_(row, js) {
  if (!row || !js || isSticky_(row.manualStatus)) return false;
  var ns = JIRA_STAGE_STATUS_[js.stage] || 'JIRA';
  if (ns === 'DONE') {
    if (isTrue_(row.closed) && row.status === 'DONE') return false;
    row.priorityReason = jiraStageReason_(js); row.aiStatus = 'DONE'; markClosed_(row, 'DONE', 'jira (sen kapattın)'); return true;
  }
  if (row.status === ns && !isTrue_(row.closed)) return false;
  row.status = ns; row.aiStatus = ns; row.priorityReason = jiraStageReason_(js); row.updatedAt = new Date().toISOString();
  if (ns === 'MY_REPLY') row.priority = 1;
  return true;
}
// Jira bildirimi kartından Jira'ya yazdığım SON yorumun içeriği kartın durumunu belirler
// Ekibe iş verdiysen task To Do'ya döner → "Jira · Alınmayı Bekliyor" (ekip alınca Ekip Yapıyor'a geçer)
var JIRA_COMMENT_EFFECT_ = { ASKED_CLIENT: 'WAITING_CLIENT', DELEGATED: 'JIRA', TOOK_OVER: 'IN_PROGRESS', CLOSED: 'COMPLETED', INFO: 'JIRA' };
var JIRA_COMMENT_REASON_ = { ASKED_CLIENT: 'Jira yorumuna göre markadan dönüş bekleniyor', DELEGATED: 'Jira yorumunda işi ekibe verdin, ekibin alması bekleniyor', TOOK_OVER: 'Jira yorumunda işi üstlendin', CLOSED: 'Jira yorumunla iş tamamlandı', INFO: 'Jira\'da yorumla cevapladın' };
function jiraMyComments_() { try { return JSON.parse(PropertiesService.getUserProperties().getProperty('JIRA_MY_COMMENTS') || '{}'); } catch (e) { return {}; } }
function jiraMyCommentSet_(threadId, key, eff) {
  var all = jiraMyComments_(), id = String(threadId); delete all[id];
  all[id] = { t: new Date().toISOString(), key: key, eff: eff };
  var ids = Object.keys(all); if (ids.length > 300) ids.slice(0, ids.length - 300).forEach(function (k) { delete all[k]; });
  PropertiesService.getUserProperties().setProperty('JIRA_MY_COMMENTS', JSON.stringify(all));
}
/** Yorumumun etkisi: AI ile (kısa çağrı), olmazsa kelime kuralı */
function jiraCommentEffect_(body, cfg, st) {
  var t = String(body || '').slice(0, 3000);
  try {
    var a = safeJson_(callGemini_([
      'Aşağıdaki yorumu ' + (cfg.MY_NAME || 'kullanıcı') + ' (ajans tarafında işi yöneten kişi) bir Jira task\'ine ekibine yazdı. Bu yorumdan sonra işin topu kimde? Tek bir etki seç:',
      'DELEGATED = ekipten birine bir şey yaptırıyor, soruyor, kontrol ettiriyor ya da ekibin dönüşünü bekliyor (@etiket, "bakabilir misin", "kurar mısın", "güncelleyelim").',
      'ASKED_CLIENT = markadan bir şey bekleniyor (onay, materyal, bilgi; "markaya sordum", "markadan dönüş bekliyoruz").',
      'TOOK_OVER = işi kendisi üstlendi ya da kendisi takip edecek ("ben hallediyorum", "markaya ileteceğim", "kontrol edip dönüyorum").',
      'CLOSED = iş bitti, onaylandı, teşekkür/kapanış; kimseden bir şey beklenmiyor.',
      'INFO = sadece bilgi, net bir sonraki adım yok.',
      st ? 'TASK: ' + st.key + ' | ' + st.summary + ' | Durum: ' + st.status : '',
      'YORUM:', t,
      'SADECE şu JSON\'u döndür: {"effect": "DELEGATED|ASKED_CLIENT|TOOK_OVER|CLOSED|INFO"}'
    ].filter(String).join('\n'), cfg));
    var e = String(a.effect || '').toUpperCase().trim();
    if (JIRA_COMMENT_EFFECT_[e]) return e;
  } catch (err) { try { log_('WARN', 'Jira yorum etkisi AI ile bulunamadı: ' + err); } catch (e2) {} }
  var f = foldTr_(t);
  if (/(tamamdir|tesekkur|tamamlandi|yayina aldik|kapatabiliriz|onaylandi)/.test(f) && !/\?/.test(t)) return 'CLOSED';
  if (/marka(dan|ya)?\s.*(bekl|sordum|ilettim|onay)/.test(f)) return 'ASKED_CLIENT';
  if (/(^|\s)@\S/.test(t) || /\?|bakabilir|rica|kurar mi|yapabilir|guncelleyelim|ekleyelim/.test(f)) return 'DELEGATED';
  if (/(hallederim|hallediyorum|iletecegim|iletiyorum|donuyorum|takip ediyorum)/.test(f)) return 'TOOK_OVER';
  return 'INFO';
}
// Jira işi ↔ marka maili eşleşmesi (Markaya dön için)
function jiraIssueThreads_() { try { return JSON.parse(PropertiesService.getUserProperties().getProperty('JIRA_ISSUE_THREADS') || '{}'); } catch (e) { return {}; } }
function jiraIssueThreadSet_(key, threadId) {
  if (!key || !threadId) return;
  var all = jiraIssueThreads_(); delete all[key]; all[key] = String(threadId);
  var ks = Object.keys(all); if (ks.length > 500) ks.slice(0, ks.length - 500).forEach(function (k) { delete all[k]; });
  PropertiesService.getUserProperties().setProperty('JIRA_ISSUE_THREADS', JSON.stringify(all));
}
function processThread_(thread, facts, cfg, prevRow, ai) {
  if (!ai) ai = classifyWithGemini_(facts, cfg);
  var row = prevRow ? JSON.parse(JSON.stringify(prevRow)) : {};

  var isWork = ai.is_real_work !== false;
  // Geniş dağıtım kararı: liste/grup sinyali VEYA içerik bazlı AI kararı (alıcı sayısı DEĞİL)
  if (ai.is_broadcast === true) facts.isDistribution = true;
  else if (ai.is_broadcast === false && !facts.groupList) facts.isDistribution = false;
  var direct = facts.directToMe || ai.addressed_to_me === true;
  var needsMe = ai.requires_my_action === true && facts.lastSenderRole !== 'ME';

  var p = parseInt(ai.priority, 10);
  if (!(p >= 1 && p <= 5)) p = 3;
  var reason = ai.priority_reason || '';
  var status = STATUSES.indexOf(ai.status) >= 0 ? ai.status : 'IN_PROGRESS';
  if (['STALE', 'REMINDED', 'DONE', 'JIRA', 'JIRA_WIP', 'JIRA_DONE', 'INTERNAL', 'AUTO'].indexOf(status) >= 0) status = 'IN_PROGRESS';
  // Top kimde? AI'ın açık cevabı + son mesajın yönü birlikte değerlendirilir
  var waitingOn = String(ai.waiting_on || '').toUpperCase();
  var rawStatusCW = status;
  if (['IN_PROGRESS', 'WAITING_CM', 'WAITING_CLIENT'].indexOf(status) >= 0) {
    if (waitingOn === 'CLIENT' && (facts.lastToClient || facts.lastSenderRole !== 'EXTERNAL' || status === 'WAITING_CLIENT')) status = 'WAITING_CLIENT';
    else if (waitingOn === 'BIZ' && status === 'WAITING_CLIENT') status = 'IN_PROGRESS';
    else if (status === 'WAITING_CLIENT' && !facts.lastToClient && facts.lastSenderRole === 'EXTERNAL') status = 'IN_PROGRESS';
    // Son mesaj bizden dışarıya gitti ve AI işin bizde olduğunu açıkça söylemedi → dışarıdan cevap bekleniyor
    if (status === 'IN_PROGRESS' && facts.lastToClient && waitingOn !== 'BIZ') status = 'WAITING_CLIENT';
  }
  // Kullanıcı CM yerine cevap verdiyse işi üstlenmiştir: CM'in cevabı beklenmez → iş devam ediyor
  if (facts.lastSenderRole === 'ME' && ['WAITING_CM', 'MY_REPLY'].indexOf(status) >= 0) status = 'IN_PROGRESS';
  // Son mesaj benimse durumu cevabımın içeriği belirler (markaya soru → Markada Bekleyen, CM'e devir → CM Cevabı, üstlenme → Devam, kapanış → Tamamlandı)
  var myEff = String(ai.my_reply_effect || '').toUpperCase();
  if (facts.lastSenderRole === 'ME' && MY_REPLY_EFFECT_[myEff]) { status = MY_REPLY_EFFECT_[myEff]; row._myEffect = myEff; }
  // CM/ekip son mesajda BIZ içinden birine soru sorduysa / destek istediyse iş BIZ'de devam ediyor
  if (['CM', 'INTERNAL'].indexOf(facts.lastSenderRole) >= 0 && ['WAITING_CLIENT', 'COMPLETED', 'WAITING_CM'].indexOf(status) >= 0 &&
      askedInternal_(facts.cache && facts.cache.lastBody, facts.cache, cfg)) { status = 'IN_PROGRESS'; ai.cm_committed = false; }
  // Markada Bekleyen SADECE son BIZ mesajı markadan açıkça bir şey istiyorsa (soru/onay/geri bildirim/materyal).
  // Sadece teslim/bilgilendirme → iş tamamlandı; AI işi BIZ'de gördüyse veya dönüş sözü varsa → devam ediyor.
  var aiNoAsk = typeof ai.client_request === 'string' && !ai.client_request.trim();   // AI açıkça "markadan istenen bir şey yok" dedi
  if (status === 'WAITING_CLIENT' && aiNoAsk && ['CM', 'INTERNAL', 'ME'].indexOf(facts.lastSenderRole) >= 0 && facts.cache && facts.cache.lastBody &&
      !clientAsked_(facts.cache.lastBody)) {
    var lb = String(facts.cache.lastBody);
    status = (rawStatusCW === 'IN_PROGRESS' || PENDING_REPLY_RE.test(lb) || askedInternal_(lb, facts.cache, cfg)) ? 'IN_PROGRESS' : 'COMPLETED';
  }
  // İleri tarihli talebi CM gördü/onayladı (cevap ya da Gmail tepkisi) ve tarih henüz gelmedi → iş devam ediyor
  if (validDue_(ai) && ai.due_date >= Utilities.formatDate(new Date(), 'Europe/Istanbul', 'yyyy-MM-dd') &&
      ['CM', 'INTERNAL', 'ME'].indexOf(facts.lastSenderRole) >= 0 && ['WAITING_CLIENT', 'COMPLETED'].indexOf(status) >= 0 && !String(ai.client_request || '').trim()) {
    status = 'IN_PROGRESS'; ai.cm_committed = false;
  }

  if (facts.isJira && facts.jira && facts.jira.needsMe) {
    try {   // Jira'da bahsetmeden sonra bir şey yaptıysam (yorum, durum, açıklama) artık benden beklenmiyor
      var nk = (String(facts.subject || '').match(JIRA_KEY_RE_) || [])[1], njs = nk ? jiraStageOf_(nk) : null;
      if (njs && njs.stage !== 'ME') facts.jira.needsMe = false;
    } catch (e) {}
  }
  if (facts.isJira && facts.jira && facts.jira.needsMe) {
    // Jira'da bana seslenildi ya da yorum yaptığım işe başkası yorum yazdı → Hemen Cevapla
    p = facts.jira.mention ? 1 : 2; status = 'MY_REPLY';
    reason = facts.jira.mention ? 'Jira\'da senden bahsedildi (' + facts.jira.lastActor + ')' : 'Yorum yaptığın Jira işine yeni yorum (' + facts.jira.lastActor + ')';
  } else if (facts.isJira) {
    // Jira bildirimi → ekip almadı / ekip yapıyor / ekip tamamladı (Jira API'den; bağlı değilse "Jira")
    p = 3; status = 'JIRA'; reason = 'Jira bildirimi';
    try {
      var jsk = (String(facts.subject || '').match(JIRA_KEY_RE_) || [])[1];
      var js0 = jsk ? jiraStageOf_(jsk) : null;
      if (js0) { status = JIRA_STAGE_STATUS_[js0.stage] || 'JIRA'; reason = jiraStageReason_(js0); if (status === 'DONE') row._jiraMyDone = true; if (status === 'MY_REPLY') p = 1; }
    } catch (e) {}
  } else if (facts.isMachine && !(isWork && p <= 3)) {
    // Gerçek otomatik gönderim (newsletter, platform bildirimi, bounce, OOO) ve AI iş görmedi
    p = 5; status = 'AUTO'; reason = reason || 'Otomatik gönderim';
  } else if (facts.isCalendarResponse) {
    p = 5; status = 'AUTO'; reason = 'Takvim yanıtı';
  } else if (facts.isCalendarInvite) {
    // Bana gelen takvim davetleri her zaman Hemen Cevapla (katılım yanıtı benden bekleniyor); daveti ben gönderdiysem takip
    p = 2;
    if (facts.lastSenderRole === 'ME') { status = 'FYI'; reason = 'Gönderdiğin takvim daveti'; }
    else { status = 'MY_REPLY'; reason = 'Takvim daveti — katılım yanıtı bekleniyor'; }
  } else if (needsMe) {
    // Bana (veya bana da) bir iş yapılması istenmiş → Hemen Cevapla
    p = 1; status = 'MY_REPLY'; reason = reason || 'Senden aksiyon bekleniyor';
  } else {
    if (p === 1 && !direct) p = 2;
    if (facts.onlyMeInTo && isWork && p > 1 && facts.lastSenderRole !== 'ME') { p = 1; reason = reason || 'To\'da sadece sen varsın'; }
    if (status === 'MY_REPLY' && (facts.lastSenderRole === 'ME' || !direct)) status = 'IN_PROGRESS';
    if (p === 1 && facts.lastSenderRole !== 'ME' && status !== 'COMPLETED') status = 'MY_REPLY';

    if (!isWork) {
      if (facts.isDistribution) { p = 4; status = 'INTERNAL'; reason = reason || 'Genel duyuru / geniş dağıtım'; }
      else { p = Math.max(p, 4); status = p === 5 ? 'AUTO' : 'INTERNAL'; }
    } else if (!direct && !facts.hasCm && status !== 'MY_REPLY') {
      // İş maili ama sana yönelik değil ve ekibinden bir CM yürütmüyor (başka ekipler/listeler) → sadece takip
      status = status === 'COMPLETED' ? 'COMPLETED' : 'FYI';
      if (p < 3) p = 3;
      reason = reason || 'Geniş dağıtımda iş maili — takip';
    }
    if (status === 'FYI' && p === 5) p = 4;
  }

  if (facts.isJira && !(facts.jira && facts.jira.needsMe)) {
    var jmc = jiraMyComments_()[String(facts.threadId)];
    if (jmc && jmc.t) {
      var jLast = new Date(facts.lastDate).getTime(), jMine = new Date(jmc.t).getTime() + 90000;
      if (jLast <= jMine || (facts.jira && facts.jira.lastMine)) {
        // Benim yorumumdan sonra başka bir şey olmadı → durum son yorumuma göre
        var effSt = JIRA_COMMENT_EFFECT_[jmc.eff] || 'JIRA';
        if (jmc.eff === 'DELEGATED') { status = 'JIRA'; p = 3; reason = JIRA_COMMENT_REASON_.DELEGATED + ' (' + jmc.key + ')'; row._jiraMyDone = false; }
        else if (effSt !== 'JIRA') { status = effSt; reason = (JIRA_COMMENT_REASON_[jmc.eff] || 'Jira yorumun') + ' (' + jmc.key + ')'; row._jiraMyDone = false; }
      } else if (facts.jira && facts.jira.lastComment && !jiraCreds_()) {
        // Yorum yaptığım işe benden sonra başkası yorum yazdı → bana dönüş
        p = 2; status = 'MY_REPLY'; reason = 'Yorum yaptığın Jira işine yeni yorum (' + (facts.jira.lastActor || '?') + ')';
      }
    }
  }
  if (row._myEffect && !facts.isJira && !facts.isCalendarInvite) { status = MY_REPLY_EFFECT_[row._myEffect]; reason = MY_REPLY_REASON_[row._myEffect]; }
  delete row._myEffect;
  var cm = pickClientManager_(facts, cfg, ai, isWork && !facts.isMachine);
  // Genel duyuru / otomatik gönderim ve markası yok → CM'e atanmaz
  if (['INTERNAL', 'AUTO'].indexOf(status) >= 0 && !cm.brand && cm.via !== 'jira') cm = { name: 'Atanmamış', email: '', brand: '', via: 'internal' };

  var now = new Date().toISOString();
  Object.assign(row, {
    threadId: facts.threadId,
    subject: facts.subject,
    title: ai.title || facts.subject,
    brand: cm.brand,
    cm: cm.name,
    cmEmail: cm.email,
    priority: p,
    priorityReason: reason,
    aiStatus: status,
    manualStatus: '',
    status: status,
    closed: false,
    closedAt: '',
    closedBy: '',
    summary: ai.summary || '',
    clientAsk: ai.client_ask || '',
    cmResponse: ai.cm_response || '',
    nextAction: ai.next_action || '',
    suggestedReply: status === 'MY_REPLY' ? (ai.suggested_reply || '') : '',
    participants: facts.participantsText,
    lastSender: facts.lastSenderName,
    lastSenderRole: facts.lastSenderRole,
    recentMine: !!facts.recentMine,
    firstDate: facts.firstDate,
    lastDate: facts.lastDate,
    msgCount: facts.msgCount,
    lastMsgId: facts.lastMsgId,
    addressedToMe: !!direct,
    flags: facts.flags.concat(ai.cm_committed === true ? ['CM_COMMITTED'] : []).concat(ai.client_request && String(ai.client_request).trim() ? ['CLIENT_ASKED'] : []).concat(validDue_(ai) ? ['DUE:' + ai.due_date] : []).join(','),
    link: gmailLink_(facts.threadId, cfg),
    updatedAt: now,
    hasCm: !!facts.hasCm
  });
  // Task'i kullanıcı Done'a aldıysa kart kapanır
  if (row._jiraMyDone && status === 'DONE') markClosed_(row, 'DONE', 'jira (sen kapattın)');
  delete row._jiraMyDone;
  return row;
}

function gmailLink_(threadId, cfg) {
  return 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(cfg.myEmail) + '#all/' + threadId;
}

/**
 * Thread'in gerçeklerini çıkarır — ARTIMLI.
 *  row.factsCache: daha önce işlenmiş mesajlardan biriken bilgiler (katılımcılar, sinyaller, son mesaj…)
 *  row.memory:     AI'ın thread'in tamamından çıkardığı kısa hafıza
 * Önbellek geçerliyse sadece YENİ mesajlar Gmail'den okunur ve AI'a sadece onlar + hafıza gider.
 * Önbellek/hafıza yoksa (ilk okuma) thread'in TAMAMI bir kez okunur.
 */
function extractFacts_(thread, cfg, row) {
  var all = thread.getMessages().filter(function (m) { return !m.isDraft(); });
  var me = cfg.myEmail;
  var cache = null;
  try { cache = row && row.factsCache && row.memory ? JSON.parse(row.factsCache) : null; } catch (e) { cache = null; }
  // Önbellek hâlâ bu thread'le uyumlu mu? (işlenmiş son mesaj yerinde duruyor mu)
  if (cache && !(cache.n > 0 && cache.n <= all.length && all[cache.n - 1].getId() === cache.lastId)) cache = null;
  if (cache && cache.n === all.length) cache = null;     // yeni mesaj yok (yeniden sınıflama) → baştan oku
  var firstRead = !cache;
  if (!cache) cache = { v: 2, n: 0, lastId: '', participants: {}, lastToMe: null, machineCount: 0, humanMsgs: 0, groupList: false, jira: false, firstDate: '', firstBody: '', lastOtherBody: '' };

  var start = cache.n;
  var fresh = all.slice(start);
  var messages = fresh.map(function (m, k) {
    var idx = start + k;
    var from = parseAddresses_(m.getFrom())[0] || { email: '', name: m.getFrom() };
    var to = parseAddresses_(m.getTo());
    var cc = parseAddresses_(m.getCc());
    [from].concat(to, cc).forEach(function (a) {
      if (!a.email) return;
      var p = cache.participants[a.email] || (cache.participants[a.email] = { name: a.name, sent: 0, to: 0, cc: 0 });
      if (a === from) p.sent++; else if (to.indexOf(a) >= 0) p.to++; else p.cc++;
      if (!p.name && a.name) p.name = a.name;
    });
    var toEmails = to.map(function (a) { return a.email; });
    var ccEmails = cc.map(function (a) { return a.email; });
    if (toEmails.indexOf(me) >= 0 || ccEmails.indexOf(me) >= 0) cache.lastToMe = { to: toEmails, cc: ccEmails };
    // Başlık okumak pahalı: ilk mesaj + son 6 mesaj
    var sig = (idx === 0 || idx >= all.length - 6) ? senderSignals_(m, from.email, cfg) : { machine: false, groupList: false, jira: false };
    var role = roleOf_(from.email, cfg);
    if (sig.machine) cache.machineCount++;
    else if (role !== 'ME') cache.humanMsgs++;
    if (sig.groupList) cache.groupList = true;
    if (sig.jira) cache.jira = true;
    var body = cleanBody_(m.getPlainBody() || '');
    try { var hb0 = m.getBody ? m.getBody() : ''; if (/<table/i.test(hb0)) { var tmd = htmlTablesMd_(hb0); if (tmd) body += '\n\n[Maildeki tablo, sütun yapısıyla]\n' + tmd; } } catch (e) {}
    var date = m.getDate();
    if (idx === 0) { cache.firstDate = date.toISOString(); cache.firstBody = body.slice(0, 1500); }
    if (role !== 'ME') cache.lastOtherBody = body.slice(0, 600);
    cache.lastBody = body.slice(0, 1500);
    return { from: from, to: to, cc: cc, role: role, date: date, body: body, machine: sig.machine, index: idx + 1 };
  });
  var last = messages[messages.length - 1];
  var lastMsg = all[all.length - 1];
  cache.n = all.length;
  cache.lastId = lastMsg.getId();
  cache.last = { email: last.from.email, name: last.from.name, role: last.role, machine: last.machine,
                 to: last.to.map(function (a) { return a.email; }), cc: last.cc.map(function (a) { return a.email; }) };

  var subject = thread.getFirstMessageSubject() || '(konu yok)';
  if (/^\s*\[jira\]/i.test(subject)) cache.jira = true;
  var jira = cache.jira;

  var lastToMe = cache.lastToMe;
  var onlyMeInTo = !!(lastToMe && lastToMe.to.length === 1 && lastToMe.to[0] === me);
  // Geniş dağıtım: alıcı SAYISINA bakılmaz. Şirket içi grup listesi, dağıtım adresi ya da
  // senin To/Cc'de hiç olmaman (bir liste üzerinden gelmiş) → dağıtım. İçerik bazlı karar AI'da (is_broadcast).
  var distAddr = function (e) { return cfg.distPatterns.some(function (p) { return e.indexOf(p) === 0; }); };
  var isDistribution = cache.groupList || !lastToMe || (lastToMe && lastToMe.to.concat(lastToMe.cc).some(distAddr)) || false;

  var greet = fold_((cache.lastOtherBody || '').slice(0, 250));
  var namedMe = cfg.aliases.some(function (a) { return a && greet.indexOf(fold_(a)) >= 0; });
  var meInTo = !!(lastToMe && lastToMe.to.indexOf(me) >= 0);
  var directToMe = onlyMeInTo || (meInTo && namedMe);

  var calRe = /^(invitation|updated invitation|invitation updated|davet|güncellenmiş davet|güncellenen davet|new event|yeni etkinlik)\b/i;
  var calRespRe = /^(accepted|declined|tentative|kabul edildi|reddedildi|belki|canceled event|cancelled event|iptal edilen etkinlik|etkinlik iptal)\b/i;
  var isCalendarResponse = calRespRe.test(subject);
  var isCalendarInvite = !isCalendarResponse && (calRe.test(subject) || hasIcs_(lastMsg));

  var isMachine = !jira && cache.machineCount > 0 && cache.humanMsgs === 0;

  var pList = Object.keys(cache.participants).map(function (e) { var p = cache.participants[e]; return { email: e, name: p.name, sent: p.sent, to: p.to, cc: p.cc }; });
  var hay = fold_(subject + ' ' + pList.map(function (p) { return p.email + ' ' + (p.name || ''); }).join(' ') + ' ' + (cache.firstBody || ''));
  var ignoredBrand = cfg.ignoreBrands.some(function (b) { return b && hay.indexOf(b) >= 0; });

  var hasCm = cfg.cms.some(function (c) { return cache.participants[c.email]; });
  var lastToClient = last.role !== 'EXTERNAL' && !last.machine &&
    last.to.concat(last.cc).some(function (a) { return roleOf_(a.email, cfg) === 'EXTERNAL'; });

  var flags = [];
  if (onlyMeInTo) flags.push('ONLY_ME_IN_TO');
  if (directToMe) flags.push('DIRECT');
  if (isMachine) flags.push('MACHINE');
  if (cache.groupList) flags.push('GROUP_LIST');
  if (jira) flags.push('JIRA');
  if (isCalendarInvite) flags.push('CALENDAR');
  if (isCalendarResponse) flags.push('CAL_RESPONSE');
  if (isDistribution) flags.push('DISTRIBUTION');
  if (ignoredBrand) flags.push('IGNORED_BRAND');
  if (lastToClient) flags.push('LAST_TO_CLIENT');

  return {
    threadId: thread.getId(),
    subject: subject,
    msgCount: thread.getMessageCount(),
    totalMessages: all.length,
    lastMsgId: lastMsg.getId(),
    firstDate: cache.firstDate || messages[0].date.toISOString(),
    lastDate: last.date.toISOString(),
    lastSenderName: last.from.name || last.from.email,
    lastSenderEmail: last.from.email,
    lastSenderRole: last.role,
    onlyMeInTo: onlyMeInTo,
    directToMe: directToMe,
    isDistribution: isDistribution,
    isMachine: isMachine,
    isJira: jira,
    groupList: cache.groupList,
    isCalendarInvite: isCalendarInvite,
    isCalendarResponse: isCalendarResponse,
    ignoredBrand: ignoredBrand,
    hasCm: hasCm,
    lastToClient: lastToClient,
    // Son 3 mesajdan en az biri benden mi? ("Benim aktif" filtresi). Thread zaten bellekte, ek istek yok.
    recentMine: all.slice(-3).some(function (m) { return roleOf_((parseAddresses_(m.getFrom())[0] || {}).email, cfg) === 'ME'; }),
    jira: jira ? jiraInfo_(all, cfg) : null,
    flags: flags,
    participants: pList,
    participantsText: pList.map(function (p) { return (p.name || p.email); }).slice(0, 12).join(', '),
    messages: messages,          // sadece yeni mesajlar (ilk okumada hepsi)
    firstRead: firstRead,
    memory: firstRead ? '' : (row && row.memory) || '',
    cache: cache
  };
}

function roleOf_(email, cfg) {
  email = lc_(email || '');
  if (email === cfg.myEmail) return 'ME';
  if (cfg.cms.some(function (c) { return c.email === email; })) return 'CM';
  var dom = email.split('@')[1] || '';
  if (cfg.internalDomains.indexOf(dom) >= 0) return 'INTERNAL';
  return 'EXTERNAL';
}

/**
 * Göndereni sınıflar.
 *  - groupList: Google Groups / şirket içi dağıtım listesi (tokyo@, ad@, mt@…) → NEWSLETTER DEĞİL.
 *    Bu listeler List-Id, List-Unsubscribe ve "Precedence: list" başlığı ekler; v1'de hata buradaydı.
 *  - machine: gerçekten otomatik (newsletter servisi, platform bildirimi, bounce, otomatik yanıt).
 *  - jira: Jira bildirimi.
 */
function senderSignals_(m, fromEmail, cfg) {
  var h = function (n) { try { return String(m.getHeader(n) || ''); } catch (e) { return ''; } };
  var fromL = lc_(fromEmail || '');
  var listId = lc_(h('List-Id'));
  var listUnsub = lc_(h('List-Unsubscribe'));
  var prec = lc_(h('Precedence')).trim();
  var auto = lc_(h('Auto-Submitted')).trim();
  var groupId = h('X-Google-Group-Id');
  var mailingList = lc_(h('Mailing-list'));
  var feedbackId = h('Feedback-ID');
  var subject = lc_(m.getSubject() || '');

  var jira = cfg.jiraPatterns.some(function (p) { return fromL.indexOf(p) >= 0; }) || /^\s*(re:\s*)?\[jira\]/i.test(subject);

  var internalList = cfg.internalDomains.some(function (d) { return listId.indexOf(d.replace(/\./g, '.')) >= 0 || mailingList.indexOf('@' + d) >= 0; });
  var groupList = !!groupId || listUnsub.indexOf('googlegroups') >= 0 || internalList;

  var noreply = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|newsletter|news|bulten|bülten|mailer|marketing|bounce|mailer-daemon|postmaster|alerts?|updates?)[@+.-]|[-.]noreply@|noreply-/i.test(fromL);
  var autoReply = /^(ooo\b|out of office|automatic reply|auto(matic)?[- ]?reply|otomatik (yanıt|cevap)|delivery status notification|undeliverable|teslim edilemedi|mail delivery (failed|subsystem))/i.test(subject);
  var esp = !!feedbackId || /mailchimp|sendgrid|mailgun|amazonses|sparkpost|klaviyo|hubspot|salesforce|mandrill|brevo|sendinblue|insider/i.test(h('X-Mailer') + ' ' + h('List-Id') + ' ' + listUnsub);

  var machine = false;
  if (!groupList) {
    if (auto && auto !== 'no') machine = true;
    else if (prec === 'bulk' || prec === 'junk') machine = true;
    else if (listUnsub && (esp || noreply)) machine = true;
    else if (noreply || autoReply) machine = true;
    else if (listId && !internalList) machine = true;
  } else {
    // Google Group'tan geçen bir mail de bounce/otomatik olabilir
    if (autoReply || /mailer-daemon|postmaster/.test(fromL)) machine = true;
  }
  if (jira) machine = false;
  return { machine: machine, groupList: groupList, jira: jira };
}

function hasIcs_(msg) {
  try {
    return msg.getAttachments({ includeInlineImages: false }).some(function (a) {
      return /text\/calendar/i.test(a.getContentType()) || /\.ics$/i.test(a.getName());
    });
  } catch (e) { return false; }
}

/** "Ad Soyad <a@b.com>, c@d.com" → [{name, email}] (tırnak içindeki virgüllere dayanıklı) */
function parseAddresses_(s) {
  if (!s) return [];
  var out = [];
  var re = /(?:"([^"]*)"|([^,<"]*?))\s*<([^>]+)>|([^\s,<>"]+@[^\s,<>"]+)/g;
  var m;
  while ((m = re.exec(s)) !== null) {
    if (m[3]) out.push({ name: (m[1] || m[2] || '').trim(), email: m[3].trim().toLowerCase() });
    else if (m[4]) out.push({ name: '', email: m[4].trim().toLowerCase() });
  }
  return out;
}

/** Düz metinden alıntıları, imzayı, yasal uyarıları ve sınıflandırma bantlarını temizler */
/** Maildeki veri tablolarını markdown'a çevirir (alıntı öncesi kısım; yerleşim/imza tabloları atlanır) */
function htmlTablesMd_(html) {
  var h = String(html || '');
  var cut = h.search(/id="?divRplyFwdMsg|class="?(x_)?gmail_quote|<blockquote|id="?appendonsend|-----\s*Original Message|border-top:\s*solid #(E1E1E1|B5C4DF)|<b>(<span[^>]*>)?\s*(Gönderen|From|Kimden)\s*:/i);
  if (cut > 0) h = h.slice(0, cut);
  var ent = function (t) { return t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&#8217;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); }); };
  var out = [], re = /<table\b[^>]*>([\s\S]*?)<\/table>/gi, m;
  while ((m = re.exec(h))) {
    var inner = m[1]; if (/<table\b/i.test(inner)) continue;                 // iç içe tablo = yerleşim/imza
    var rows = [];
    inner.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, function (_, tr) {
      var cs = [];
      tr.replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi, function (__, td) { cs.push(ent(td.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().replace(/\|/g, '/')); return __; });
      if (cs.some(function (c) { return c; })) rows.push(cs);
      return _;
    });
    var cols = Math.max.apply(null, rows.map(function (r) { return r.length; }).concat([0]));
    var filled = rows.reduce(function (a, r) { return a + r.filter(Boolean).length; }, 0), all = rows.map(function (r) { return r.join(' '); }).join(' ');
    if (rows.length < 2 || cols < 2 || filled < 4) continue;
    if (/@[a-z0-9.-]+\.[a-z]{2,}|\+90|\bwww\./i.test(all) && filled <= 14) continue;   // imza tablosu
    out.push(rows.map(function (r, i) { while (r.length < cols) r.push(''); return '| ' + r.join(' | ') + ' |' + (i === 0 ? '\n|' + r.map(function () { return '---'; }).join('|') + '|' : ''); }).join('\n'));
  }
  return out.slice(0, 5).join('\n\n');
}
function cleanBody_(text) {
  var lines = String(text).replace(/\r/g, '').replace(/ /g, ' ').split('\n');
  var out = [];
  var cutRe = [
    /^On .{5,200} wrote:\s*$/i,
    /^.{5,200} tarihinde .{0,200} (şunu )?yazdı:\s*$/i,
    /^-{2,}\s*(Original Message|Özgün İleti|Orijinal Mesaj)\s*-{2,}/i,
    /^(From|Kimden|Gönderen)\s*:\s.+/i,
    /^_{8,}\s*$/,
    /^--\s*$/
  ];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var t = l.trim();
    if (i > 1 && cutRe.some(function (r) { return r.test(t); })) break;
    if (/^\s*>/.test(l)) continue;
    if (BANNER_RE.test(t)) continue;
    out.push(l);
  }
  // Yasal uyarı paragraflarını çıkar
  var paras = out.join('\n').split(/\n\s*\n/).filter(function (p) {
    return !DISCLAIMER_RES.some(function (r) { return r.test(p.replace(/\s+/g, ' ')); });
  });
  var cleaned = paras.join('\n\n').split('\n');
  // İmza: son kapanış ifadesinden sonrasını kes (en fazla 25 satır kalmışsa)
  for (var j = cleaned.length - 1; j >= 0; j--) {
    if (SIGNOFF_RE.test(cleaned[j].trim()) && cleaned.length - j <= 25) { cleaned = cleaned.slice(0, j + 1); break; }
  }
  // Kalan telefon/adres/web satırlarını at
  var hints = (_cfgCache && _cfgCache.addrHints) || [];
  // Sadece sondaki imza bölgesinde (son 12 satır); gövdedeki "LP: https://www.marka.com/..." gibi kurulum linkleri ASLA atılmaz
  var tailFrom = Math.max(0, cleaned.length - 12);
  cleaned = cleaned.filter(function (l, k) {
    if (k < tailFrom) return true;
    var t = l.trim();
    if (SIGNATURE_LINE_RE.test(t)) return false;
    if (/https?:\/\//i.test(t)) return true;
    var f = fold_(t);
    return !(t.length < 120 && hints.some(function (h) { return h && f.indexOf(h) >= 0; }));
  });
  var txt = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (txt.length > 6000) { txt = txt.slice(0, 6000); var nl = txt.lastIndexOf('\n'); if (nl > 5000) txt = txt.slice(0, nl); txt += '\n[…devamı kısaltıldı]'; }
  return txt;
}

function uniq_(a) { var s = {}; return a.filter(function (x) { return s[x] ? false : (s[x] = true); }); }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

/**
 * Marka + CM seçimi — "maile kim ekliyse iş onundur":
 *  1) Thread'de (From/To/Cc) yer alan CM'ler adaydır. Maile ekli olmayan CM'e iş ATANMAZ.
 *     Birden fazla CM ekliyse: markanın domaini / adı onun listesinde olan öne geçer,
 *     eşitlikte mesaj yazan > To > Cc ağırlığı belirler.
 *  2) Hiçbir CM ekli değilse: domain (ve gerekirse marka adı) TEK bir CM'e çıkıyorsa ona atanır.
 *     Aynı domaini birden fazla CM paylaşıyorsa (ör. ÖRN'nin farklı ekipleri) ve hiçbiri maile
 *     ekli değilse → Atanmamış (yanlış kişiye atamaktansa).
 *  NOT: Mail gövdesinde marka adı aranmaz (şirket imzasındaki adres parçaları markayla karışabiliyor).
 */
function pickClientManager_(facts, cfg, ai, allowAiBrand) {
  var r = pickClientManagerCore_(facts, cfg, ai, allowAiBrand);
  var b = brandByDomain_(facts, cfg); if (b) r.brand = b;
  return r;
}
/** BRANDS ayarındaki domainlerle markayı bul (marka filtresi bununla tutarlı çalışır) */
function brandByDomain_(facts, cfg) {
  if (!cfg.brandMap || !cfg.brandMap.length) return '';
  var doms = (facts.participants || []).map(function (p) { return lc_(p.email || '').split('@')[1] || ''; }).filter(String);
  for (var i = 0; i < cfg.brandMap.length; i++) {
    var b = cfg.brandMap[i];
    if (b.domains.some(function (d) { return doms.some(function (x) { return x === d || x.slice(-d.length - 1) === '.' + d; }); })) return b.name;
  }
  return '';
}
function pickClientManagerCore_(facts, cfg, ai, allowAiBrand) {
  var aiBrand = allowAiBrand ? String(ai.brand || '').trim() : '';
  var fb = fold_(aiBrand);
  var extDomains = facts.participants.map(function (p) { return p.email.split('@')[1] || ''; })
    .filter(function (d) { return d && cfg.internalDomains.indexOf(d) < 0; });
  var domainHit = function (c) {
    return c.domains.filter(function (d) { return extDomains.some(function (x) { return x === d || x.slice(-d.length - 1) === '.' + d; }); })[0] || '';
  };
  var brandHit = function (c) {
    if (!fb) return '';
    // En spesifik (en uzun) eşleşen marka adı: "ÖRN Home" > "ÖRN"
    return c.brands.filter(function (b) { var f = fold_(b); return f && (f === fb || fb.indexOf(f) >= 0); })
      .sort(function (x, y) { return fold_(y).length - fold_(x).length; })[0] || '';
  };
  var mostSpecific = function (list) {
    var withLen = list.map(function (c) { return { c: c, n: fold_(brandHit(c)).length }; }).filter(function (x) { return x.n > 0; });
    if (!withLen.length) return list;
    var max = Math.max.apply(null, withLen.map(function (x) { return x.n; }));
    return withLen.filter(function (x) { return x.n === max; }).map(function (x) { return x.c; });
  };
  var scoreOf = function (c) {
    var p = facts.participants.filter(function (x) { return x.email === c.email; })[0];
    return p ? p.sent * 4 + p.to * 2 + p.cc * 1 : 0;
  };
  var result = function (c, via) {
    var d = domainHit(c), b = brandHit(c);
    var brand = aiBrand || b || (d ? c.brands[c.domains.indexOf(d)] || c.brands[0] || '' : '');
    return { name: c.name, email: c.email, brand: brand, via: via };
  };

  // 1) Maile ekli CM'ler
  var inThread = cfg.cms.filter(function (c) { return scoreOf(c) > 0; });
  // Müşteri bağlamı yok (dış katılımcı yok, marka yok): şirket içi duyuru/dağıtım listesi ya da birden fazla CM'in
  // sadece cevap yazdığı iç yazışma → bir CM'e ait iş değildir
  var clientCtx = extDomains.length > 0 || !!fb || cfg.cms.some(function (c) { return brandHit(c); });
  if (!clientCtx && !facts.isJira && (facts.isDistribution || facts.groupList || inThread.length > 1)) {
    return { name: 'Atanmamış', email: '', brand: aiBrand, via: 'no-client' };
  }
  if (inThread.length) {
    var best = inThread.map(function (c) {
      var match = (domainHit(c) ? 2 : 0) + (brandHit(c) ? 1 : 0);
      return { c: c, key: match * 100000 + fold_(brandHit(c)).length * 1000 + scoreOf(c) };
    }).sort(function (x, y) { return y.key - x.key; })[0].c;
    return result(best, 'thread');
  }

  // 1b) Jira: gönderen adı "Ayşe Yılmaz (Jira)" gibi gelir → CM adıyla eşleştir
  if (facts.isJira) {
    var jn = facts.participants.map(function (p) { return fold_(String(p.name || '').replace(/\(jira\)/i, '')); });
    var jc = cfg.cms.filter(function (c) { var f = fold_(c.name); return f && jn.indexOf(f) >= 0; });
    if (jc.length === 1) return result(jc[0], 'jira');
  }

  // 2) Hiç CM ekli değil → yalnızca tekil eşleşmede ata
  var byDomain = cfg.cms.filter(function (c) { return domainHit(c); });
  // Aynı domaini birden fazla CM paylaşıyorsa ve hiçbiri maile ekli değilse → kimseye atama
  if (byDomain.length === 1) return result(byDomain[0], 'domain');
  if (!byDomain.length) {
    var byBrand = mostSpecific(cfg.cms.filter(function (c) { return brandHit(c); }));
    if (byBrand.length === 1) return result(byBrand[0], 'brand');
  }
  return { name: 'Atanmamış', email: '', brand: aiBrand, via: 'none' };
}

// ============================================================
//  GEMINI
// ============================================================
function classifyWithGemini_(facts, cfg) {
  return safeJson_(callGemini_(buildPrompt_(facts, cfg), cfg));
}

function buildPrompt_(facts, cfg) {
  var cmList = cfg.cms.map(function (c) {
    return '- ' + c.name + ' <' + c.email + '> markalar: ' + c.brands.join(', ') + (c.domains.length ? ' (domainler: ' + c.domains.join(', ') + ')' : '');
  }).join('\n');

  // İlk okumada thread'in tamamı (büyük bütçe), sonrasında sadece yeni mesajlar + hafıza
  var budget = facts.isMachine ? 4000 : (facts.firstRead ? 150000 : 40000);
  var convo = [];
  var used = 0;
  for (var i = facts.messages.length - 1; i >= 0; i--) {
    var m = facts.messages[i];
    var block = '### Mesaj ' + m.index + '/' + facts.totalMessages +
      ' | ' + Utilities.formatDate(m.date, 'Europe/Istanbul', 'dd.MM.yyyy HH:mm') +
      '\nKimden: ' + (m.from.name || '') + ' <' + m.from.email + '> [' + m.role + (m.machine ? ', OTOMATİK' : '') + ']' +
      '\nKime: ' + m.to.map(fmtAddr_).join(', ') +
      (m.cc.length ? '\nCc: ' + m.cc.map(fmtAddr_).join(', ') : '') +
      '\n\n' + m.body + '\n';
    if (used + block.length > budget && convo.length) break;
    convo.unshift(block);
    used += block.length;
  }

  var prompt = [
    'Sen ' + cfg.company + ' şirketinde ' + (cfg.MY_ROLE || 'çalışan') + ' olan ' + (cfg.MY_NAME || cfg.firstName) + ' (' + cfg.myEmail + ') için çalışan mail asistanısın.',
    'KULLANICININ İŞ AKIŞI (her maili buna göre değerlendir):',
    String(cfg.WORKFLOW || ''),
    'Metinde geçen "CM" = kullanıcının takip ettiği ' + cfg.teamRole + ' (' + cfg.teamShort + '); "BIZ" = ' + cfg.company + ' (kullanıcının şirketi); "Deniz" = ' + cfg.firstName + ' (kullanıcı).',
    facts.firstRead ? 'Aşağıdaki mail thread\'ini BAŞTAN SONA oku ve sınıfla.'
                    : 'Bu thread\'i daha önce okudun; aşağıda thread HAFIZAN ve sonrasında gelen YENİ mesajlar var. Hafızayla birlikte thread\'in tamamını bildiğini varsayarak yeniden sınıfla ve hafızayı güncelle.',
    '',
    'CLIENT MANAGER LİSTESİ:',
    cmList || '(tanımlı değil)',
    'Kullanıcıya hitap şekilleri: ' + cfg.aliases.join(', '),
    'Şirket içi domain(ler): ' + cfg.internalDomains.join(', '),
    '',
    'ÖNEMLİ AYRIMLAR:',
    '- tokyo@, ad@, mt@ gibi şirket içi Google Group adreslerinden gelen mailler EKİP DAĞITIM LİSTESİDİR, newsletter DEĞİLDİR. İçerikte gerçek bir iş konuşuluyorsa gerçek iş olarak değerlendir.',
    '- Marka = işin yapıldığı müşteri. Marka adını mailin konusu, müşterinin mail domaini ve konuşulan işten çıkar.',
    '  İMZALARDAKİ ADRESLERİ, ŞİRKET BİLGİLERİNİ, YASAL UYARILARI dikkate ALMA' + (cfg.ADDRESS_HINTS ? ' (ör. şirket adresi "' + cfg.ADDRESS_HINTS + '" bir marka değildir)' : '') + '.',
    '- Otomatik bildirim (reklam platformu uyarısı, newsletter, bounce, otomatik yanıt/OOO) gerçek iş değildir (is_real_work=false).',
    '- cm_committed: Son mesaj CM veya BIZ ekibinden ve talep edilen İŞİ YAPACAKLARINI söylüyorsa ("düzenlemeleri yapıyor olacağız", "kurulumu yapıyoruz", "aksiyon alıyoruz", "yayına alacağız") ve karşı taraftan beklenen bir şey yoksa true.',
    '  Sadece cevap sözü veren mesajlar işi üstlenmek DEĞİLDİR → cm_committed=false, waiting_on=BIZ: "dönüş yapacağım", "inceleyip döneceğim", "kontrol edip bilgi vereceğim", "bakıp dönüyorum". Bu durumda iş hâlâ CM\'de bekliyor (status WAITING_CM ya da IN_PROGRESS).',
    '  CM son mesajda BIZ içinden birine (ekip arkadaşı, başka departman) soru soruyor ya da destek istiyorsa ("+Can bize destek olabilir misin?") iş BIZ içinde DEVAM EDİYOR → status=IN_PROGRESS, waiting_on=BIZ, cm_committed=false. Bu ne tamamlandı ne markada bekliyor demektir.',
    '  Son mesaj sadece teşekkür/onay ise ve dönüş sözü ya da açık soru yoksa ("Bilgilendirme için teşekkürler.", "Teşekkürler, not aldık.") konu kapanmıştır → status=COMPLETED, waiting_on=NONE. "Teşekkürler, dönüş yapacağım" ise iş CM\'de bekliyor demektir.',
    '- is_broadcast: Mail geniş bir kitleye yapılan DUYURU mu (İK, ofis, şirket geneli bilgilendirme, eğitim/etkinlik duyurusu, toplu bilgilendirme)?',
    '  Bunu ALICI SAYISINA göre DEĞİL, içeriğe ve gönderene göre karar ver. To/Cc kalabalık olsa bile belirli bir iş konuşuluyorsa (kampanya, rapor, bütçe, marka talebi) is_broadcast=false.',
    '- requires_my_action: kullanıcıdan (tek başına YA DA "herkes/tüm ekip" gibi kullanıcıyı da kapsayan bir grup olarak) somut bir şey yapması isteniyorsa true (form doldurma, onay, bilgi gönderme, karar, katılım vb.). Başkasından (ör. sadece Alp\'ten) istenen işlerde false.',
    '',
    'ÖNCELİK (priority):',
    String(cfg.PRIORITY_RULES || ''),
    '',
    'BUGÜN: ' + Utilities.formatDate(new Date(), 'Europe/Istanbul', 'dd.MM.yyyy'),
    'İLERİ TARİHLİ TESLİM (due_date): SADECE iki durumda doldur: (1) MARKA, BIZ\'den bir işi belirli bir ileri tarihte istiyor ("2 Ekim\'de rapor rica edeceğim", "ay sonunda final raporunu alabilir miyim?") → due_source=CLIENT_REQUEST; (2) BIZ (CM/ekip) markaya bir işi belirli bir tarihte TESLİM EDECEĞİNİ söylüyor ("raporu 5 Ekim\'de ileteceğiz", "Cuma günü yayına alıyoruz") → due_source=BIZ_PROMISE. Tarihi yyyy-MM-dd yaz (yıl yoksa bugünden sonraki ilk uygun tarih). CM talebi gördüyse / onayladıysa (cevap, "tamam", Gmail tepkisi/emoji dahil) status=IN_PROGRESS, waiting_on=BIZ.',
    '  DOLDURMA: BIZ\'in markaya verdiği bilgi/uyarı niteliğindeki son tarihler ("7 Ekim\'e kadar hesabınızın doğrulanması gerekiyor", "platform 15\'inde kapanacak"), markanın kendi yapması gereken işlerin tarihleri, platform/üçüncü taraf tarihleri, geçmiş tarihler, toplantı/kampanya/yayın dönemleri. Bunlarda due_date ve due_source boş.',
    'DURUM (status) — thread\'in ŞU ANKİ durumu:',
    'MY_REPLY = kullanıcıdan cevap/onay/aksiyon bekleniyor ve son söz kullanıcıda değil.',
    'WAITING_CM = Marka (müşteri) talep iletti, sorumlu CM henüz cevap vermedi / aksiyon aldığını yazmadı.',
    '  ÖNEMLİ: Kullanıcı (board sahibi) CM yerine markaya cevap verdiyse işi kendisi üstlenmiştir; artık CM\'in cevap vermesi beklenmez. Kullanıcı işi üstlendiyse ("düzenliyoruz", "yayına alıyoruz") → IN_PROGRESS; markadan açıkça bir şey istediyse → WAITING_CLIENT; konu kapandıysa → COMPLETED. Tek istisna: kullanıcı markaya cevap vermeden işi CM\'e/ekibe devrettiyse (my_reply_effect=DELEGATED) → WAITING_CM.',
    'IN_PROGRESS = CM veya ekip cevap verdi, iş iç ekiplerde/Jira\'da devam ediyor; BIZ tarafında hâlâ yapılacak iş var.',
    'WAITING_CLIENT = BIZ (CM, ekip veya kullanıcı) markaya son mesajı iletti VE bu son mesajda markadan AÇIKÇA bir şey istendi (soru, onay, geri bildirim, materyal, karar, teyit) ya da markanın dönüş yapması net şekilde gerekiyor; BIZ tarafında bekleyen bir iş YOK.',
    '  Markadan bir şey isteniyorsa (belge/doküman talebi, onay, bilgi, materyal, erişim, karar) — soru cümlesi olmasa bile, ör. "aşağıdaki belgelerin iletilmesi gerekmektedir" — WAITING_CLIENT ve client_request DOLU olmalı.',
    '  DİKKAT: Son BIZ mesajı sadece teslim/bilgilendirme ise ("kurulumları tamamladık", "preview linkleri aşağıda", "yayına aldık", "raporu iletiyoruz") ve markadan hiçbir şey istenmiyorsa → COMPLETED (WAITING_CLIENT DEĞİL). "Marka muhtemelen inceler" varsayımı yapma; sadece mailde yazanı esas al.',
    '  Örnek: CM öneri/plan/rapor gönderdi ve "onayınızı bekliyoruz", "değerlendirmenizi rica ederiz" dedi → WAITING_CLIENT (IN_PROGRESS DEĞİL).',
    'my_reply_effect: SADECE thread\'deki SON mesaj kullanıcının kendi mesajıysa doldur, değilse NONE. Durumu kullanıcının bu son cevabının İÇERİĞİ belirler:',
    '  ASKED_CLIENT = markadan/dış taraftan açıkça bir şey istedi (soru, onay, materyal, bilgi, karar) → status=WAITING_CLIENT.',
    '  DELEGATED = markaya cevap vermeden işi CM\'e/ekibe devretti ya da onlardan bir şey istedi ("Ayşe bakabilir misin?", "+Mert bunu kurar mısın", "ekibe ilettim, dönüşlerini bekliyorum") → iş ekipte, CM/ekibin dönmesi bekleniyor → status=WAITING_CM.',
    '  TOOK_OVER = işi kendisi üstlendi ya da dönüş sözü verdi ("düzenliyoruz", "yarın iletiyorum", "kontrol edip dönüyorum") → status=IN_PROGRESS.',
    '  CLOSED = konuyu kapattı (teslim etti, onayladı, teşekkür etti, "tamamdır", "yayına aldık") ve kimseden bir şey beklemiyor → status=COMPLETED.',
    'waiting_on: Bir sonraki adımı KİM atmalı? "BIZ" (kullanıcı, CM, iç ekipler, Jira), "CLIENT" (marka: onay, geri bildirim, materyal, karar) veya "NONE" (bilgi amaçlı / kapandı).',
    '  DİKKAT: Son mesajı biz (CM/ekip/kullanıcı) markaya YA DA dış bir tarafa (Google/Meta/TikTok ekipleri, partner ajans, tedarikçi) gönderdiysek ve şimdi onlardan cevap/teyit/inceleme bekleniyorsa top DIŞARIDADIR → waiting_on=CLIENT, status=WAITING_CLIENT. "Dış taraftan dönüş bekliyoruz" işin bizde olduğu anlamına GELMEZ; BIZ sadece kendi yapması gereken bir iş varsa waiting_on=BIZ olur.',
    'COMPLETED = Güncel talep karşılandı (teslim edildi, yayına alındı, onaylandı) ve açık konu kalmadı.',
    'FYI = Aksiyon gerektirmeyen, sadece haberdar olunacak bilgi.',
    '',
    'LOOP KURALI: Bir thread birden fazla iş turu içerebilir. Daha önce tamamlanıp kapanmış işlerden BAHSETME;',
    'özet, marka talebi, CM yanıtı ve sıradaki aksiyon SADECE güncel/aktif işi anlatsın. Hepsi kapandıysa en son kapanan işi tek cümleyle anlat ve status=COMPLETED ver.',
    '',
    '',
    'THREAD HAFIZASI (memory) KURALLARI:',
    '- Thread\'in tamamının kronolojik, kısa hafızası: kim ne istedi, ne kararlaştırıldı, ne teslim edildi, tarih/rakamlar, açık kalan maddeler, kim kimdir (marka/CM/ekip).',
    '- Kapanmış turları tek satıra indir; güncel/açık konuları daha detaylı tut. En fazla ~800 kelime.',
    '- Bu hafıza, sonraki yeni mesajlarda thread\'i tekrar okumadan anlaman için kullanılacak; önemli bir bilgiyi atlama.',
    '',
    'THREAD BİLGİLERİ (sistem tarafından hesaplandı):',
    JSON.stringify({
      konu: facts.subject,
      mesaj_sayisi: facts.msgCount,
      to_da_sadece_kullanici: facts.onlyMeInTo,
      kullaniciya_isimle_hitap: facts.directToMe,
      sirket_ici_grup_listesi: facts.groupList,
      genis_dagitim: facts.isDistribution,
      tum_mesajlar_otomatik_gorunuyor: facts.isMachine,
      jira_bildirimi: facts.isJira,
      takvim_daveti: facts.isCalendarInvite,
      threadde_cm_var: facts.hasCm,
      son_gonderen: facts.lastSenderName + ' <' + facts.lastSenderEmail + '>',
      son_gonderen_rolu: facts.lastSenderRole,
      son_mesaj_sem_tarafindan_markaya: facts.lastToClient
    }),
    '',
    facts.firstRead ? '' : 'THREAD HAFIZASI (mesaj 1-' + (facts.totalMessages - facts.messages.length) + ' arası):\n' + (facts.memory || '(yok)') + '\n',
    (facts.firstRead ? 'THREAD (tamamı, kronolojik' : 'YENİ MESAJLAR (kronolojik') + '; alıntılar, imzalar ve yasal uyarılar temizlendi' + (convo.length < facts.messages.length ? ', en eski mesajların bir kısmı bütçe nedeniyle kısaltıldı' : '') + '):',
    convo.join('\n'),
    '',
    'SADECE şu JSON\'u döndür (Türkçe, kısa ve net):',
    '{',
    '  "title": "kartta görünecek 3-8 kelimelik iş başlığı (Jira ise issue anahtarıyla, ör. ORNPERF-447 Günlük kontrol)",',
    '  "brand": "müşteri marka adı veya boş",',
    '  "client_manager_email": "listeden sorumlu CM maili veya boş",',
    '  "priority": 1-5,',
    '  "priority_reason": "tek kısa cümle",',
    '  "status": "MY_REPLY|WAITING_CM|IN_PROGRESS|WAITING_CLIENT|COMPLETED|FYI",',
    '  "waiting_on": "BIZ|CLIENT|NONE",',
    '  "my_reply_effect": "ASKED_CLIENT|DELEGATED|TOOK_OVER|CLOSED|NONE",',
    '  "addressed_to_me": true/false,',
    '  "requires_my_action": true/false,',
    '  "is_real_work": true/false,',
    '  "is_big_brief": true/false,',
    '  "is_broadcast": true/false,',
    '  "cm_committed": true/false,',
    '  "due_date": "yyyy-MM-dd veya boş",',
    '  "due_source": "CLIENT_REQUEST|BIZ_PROMISE veya boş",',
    '  "summary": "güncel işin özeti: ne konuşuluyor, nerede kaldı (2-4 cümle)",',
    '  "client_ask": "marka ne istedi (tek cümle, yoksa boş)",',
    '  "client_request": "SON BIZ mesajı markaya/dış tarafa gittiyse: o mesajda markadan istenen şey (belge, onay, bilgi, materyal, karar…) kısa ve mailden alıntıya yakın; hiçbir şey istenmiyorsa ya da son mesaj bizden değilse boş string",',
    '  "cm_response": "CM/ekip ne dedi / ne yaptı (tek cümle, yoksa boş)",',
    '  "next_action": "sıradaki adım ve kimde (tek cümle)",',
    '  "memory": "güncellenmiş thread hafızası (yukarıdaki kurallara göre)"',
    '}'
  ].join('\n');

  return prompt;
}

// ============================================================
//  CEVAP TASLAĞI — yazı avatarıyla ayrı çağrı
//  Otomatik: sadece Hemen Cevapla (MY_REPLY) kartları. İstek üzerine: her kartta "AI ile cevap yaz".
// ============================================================
/** Son mesaja "tümünü yanıtla" alıcıları ve hitap kuralı (kodla belirlenir, AI'a bırakılmaz) */
function replyAudience_(facts, cfg) {
  var last = facts.lastMessage || facts.messages[facts.messages.length - 1] || {};
  var all = facts.rcptOverride && facts.rcptOverride.length ? facts.rcptOverride.map(function (e) { return { email: e, name: '' }; })
          : [last.from].concat(last.to || [], last.cc || []).filter(function (a) { return a && a.email; });
  var seen = {}, rec = [];
  all.forEach(function (a) { var e = lc_(a.email); if (e === cfg.myEmail || seen[e]) return; seen[e] = 1; rec.push(a); });
  var roles = rec.map(function (a) { return roleOf_(a.email, cfg); });
  var kind = roles.indexOf('EXTERNAL') >= 0 ? 'MARKA' : (roles.length && roles.every(function (r) { return r === 'CM'; }) ? 'CM' : 'IC');
  // Yazı avatarı (Style.gs) iç ekip / CM için farklı hitap tanımlıyorsa onu uygular; yoksa genel açılış/kapanış
  var rule = kind === 'MARKA' ? 'Alıcılarda marka/dış taraf var → açılış "' + (cfg.REPLY_OPENING || 'Selamlar,') + '", kapanış "' + (cfg.REPLY_CLOSING || 'Sevgiler,') + '".'
           : kind === 'CM' ? 'Alıcılar sadece account/client manager ekibi (iç) → yazı avatarındaki CM hitabını kullan; yoksa kısa ve rahat bir iç ekip dili.'
           : 'Alıcılar sadece iç ekip → yazı avatarındaki iç ekip hitabını kullan; yoksa kısa ve rahat bir iç ekip dili.';
  return { rec: rec, kind: kind, rule: rule };
}
function buildReplyPrompt_(facts, cfg, memory, hint) {
  var aud = replyAudience_(facts, cfg);
  var budget = 30000, used = 0, convo = [];
  for (var i = facts.messages.length - 1; i >= 0; i--) {
    var m = facts.messages[i];
    var block = '### ' + Utilities.formatDate(m.date, 'Europe/Istanbul', 'dd.MM.yyyy HH:mm') + ' | ' + (m.from.name || '') + ' <' + m.from.email + '> [' + m.role + ']\n' + m.body + '\n';
    if (used + block.length > budget && convo.length) break;
    convo.unshift(block); used += block.length;
  }
  var lastM = facts.messages[facts.messages.length - 1] || {};
  return [
    lastM.role === 'ME' && hint
      ? 'Sen ' + cfg.MY_NAME + '\'sın. Aşağıdaki mail thread\'inde SON mesaj senin. Bu thread\'e onun adına, birinci ağızdan yeni bir TAKİP mesajı yazacaksın; konusu aşağıdaki NOT\'taki gelişme.'
      : 'Sen ' + cfg.MY_NAME + '\'sın. Aşağıdaki mail thread\'inin SON mesajına onun adına, birinci ağızdan cevap taslağı yaz.',
    'ŞU AN: ' + nowStr_(),
    'ZAMAN KURALI: Mesajların tarih ve saatine bak. Cevap en güncel duruma göre yazılır; daha önce cevaplanmış, kapanmış ya da eski konuları yeniden açma, eski bir sorunun cevabını yeni gibi tekrar etme. "Bugün", "yarın", "Cuma" gibi ifadeleri ŞU AN\'a göre doğru kullan.',
    'CEVABIN GİDECEĞİ KİŞİLER (tümünü yanıtla): ' + aud.rec.map(function (a) { return fmtAddr_(a) + ' [' + roleOf_(a.email, cfg) + ']'; }).join(', '),
    'HİTAP KURALI (zorunlu): ' + aud.rule,
    'Account/client manager listesi: ' + (cfg.cms || []).map(function (c) { return c.name + ' <' + c.email + '>'; }).join(', '),
    hint ? 'KULLANICININ NOTU (cevap bunu söylemeli): ' + String(hint).slice(0, 12000) : '',
    'İmza ekleme (Gmail imzası otomatik eklenir). Bilmediğin tarih/rakam/isim için [KÖŞELİ PARANTEZ] yer tutucu bırak.',
    '',
    (writingStyle_() ? '--- YAZI AVATARI ---\n' + writingStyle_() + '\n--- YAZI AVATARI SONU ---'
      : 'YAZIM: ' + String(cfg.REPLY_TONE || 'net, kısa, profesyonel ama sıcak') + ' Marka/dış tarafa yapı: ' + (cfg.REPLY_OPENING || 'Selamlar,') + ' … ' + (cfg.REPLY_CLOSING || 'Sevgiler,')),
    '',
    memory ? 'THREAD HAFIZASI (önceki mesajların özeti):\n' + String(memory).slice(0, 4000) + '\n' : '',
    'THREAD (kronolojik, en sonda cevaplanacak son mesaj; alıntı/imza temizlendi):',
    convo.join('\n'),
    '',
    'SADECE şu JSON\'u döndür: {"reply": "gönderilmeye hazır mail gövdesi"}'
  ].join('\n');
}
/** Board: "Jira'ya aktar" — işi ekibe iletmek için Jira task başlığı + açıklaması (kullanıcının ağzından) */
function generateJiraText(threadId, hint) {
  var cfg = getConfig_();
  var th = apiThread_(String(threadId));
  if (!th || !th.exists()) throw new Error('Thread bulunamadı');
  var db = loadDb_(), row = db.byId[String(threadId)];
  var facts = extractFacts_(th, cfg, null);
  var budget = 30000, used = 0, convo = [];
  for (var i = facts.messages.length - 1; i >= 0; i--) {
    var m = facts.messages[i];
    var block = '### ' + Utilities.formatDate(m.date, 'Europe/Istanbul', 'dd.MM.yyyy HH:mm') + ' | ' + (m.from.name || '') + ' <' + m.from.email + '> [' + m.role + ']\n' + m.body + '\n';
    if (used + block.length > budget && convo.length) break;
    convo.unshift(block); used += block.length;
  }
  var me = cfg.MY_NAME || 'kullanıcı';
  var atts = []; try { atts = getThreadAttachments(threadId); } catch (e) {}
  var attAi = attachmentsForAi_(atts);
  var prompt = [
    'Sen ' + me + '\'sın. Aşağıdaki mail thread\'indeki işi ajans içindeki iki uygulama ekibine iletmek için İKİ AYRI Jira task\'ı hazırlayacaksın: biri SM ekibine, biri Google ekibine. ' + me + ' bunları Jira\'ya kopyala yapıştır yapacak.',
    'EKİPLER:',
    '- SM ekibi: Meta (Facebook/Instagram), TikTok, Snapchat, Pinterest gibi sosyal medya reklam kurulumları, kitleler, kreatif yüklemeleri, katalog kampanyaları.',
    '- Google ekibi: Google Ads (Search, PMax, Demand Gen, Shopping, App), YouTube, Merchant Center, Google tarafı kitle/feed/ölçümleme işleri.',
    '- Her task SADECE o ekibin yapacağı kısmı anlatır. İşin o ekibi hiç ilgilendirmiyorsa relevant=false yap, title ve body boş kalsın, reason alanına tek cümle neden yaz. Ortak bilgi (tarih, bütçe, markanın talebi) iki task\'ta da tekrar edebilir.',
    'BUGÜN: ' + Utilities.formatDate(new Date(), 'Europe/Istanbul', 'dd.MM.yyyy'),
    row && row.brand ? 'Marka: ' + row.brand : '',
    hint ? 'NOT (' + me + ' bunu özellikle istedi, açıklamaya yansıt): ' + String(hint).slice(0, 500) : '',
    '',
    JIRA_TITLE_RULE_,
    (function () { var ex = jiraTitleExamples_(row && row.brand, threadId); return ex.length ? 'BU MARKANIN JIRA PROJESİNDEKİ SON BAŞLIKLAR (marka kısa adını ve dili buradan öğren; formatı yukarıdaki kurala göre kur):\n' + ex.map(function (t) { return '- ' + t; }).join('\n') : ''; })(),
    'AÇIKLAMA KURALLARI:',
    '- ' + me + '\'ın ağzından, ekibe yazıyormuş gibi. Konuşma dili, samimi ve rahat ama cıvık değil; laubali kalıp, şaka, emoji, ünlem yok.',
    '- "Selam," ile başla. Kapanışta imza ya da "Sevgiler" yok; gerekiyorsa tek kısa cümleyle "Takvime göre yetişmesi önemli." gibi bitir. "Bitince buraya yaz, markaya bilgi geçerim", "Kurulumları tamamlayınca haber ver" gibi kapanış/geri bildirim cümleleri YAZMA, ekip bunu zaten biliyor.',
    '- Her cümle büyük harfle başlar. Noktalama olarak nokta ve virgül kullan, soru sorarken soru işareti kullan. Noktalı virgül, ünlem, üç nokta, parantez içi uzun açıklama kullanma.',
    '- Tek ve basit iş ise 2-4 cümle yeter. Çok detay varsa (birden fazla kampanya, tarih, bütçe, görsel, link) kısa bir giriş cümlesinden sonra "-" ile madde madde yaz; gerekirse "Detaylar:" gibi tek kelimelik başlık kullanabilirsin.',
    '- İçerik: Markanın tespiti ve gerekçesi (ne gördü, neden istiyor), ne yapılacak, gerekli detaylar (kampanya/kitle adları birebir, rakamlar, tarihler, bütçe, linkler, görseller), teslim/yayın tarihi.',
    JIRA_CONTEXT_RULE_,
    JIRA_FORMAT_RULE_,
    '- Mailde olmayan bilgiyi uydurma. Bilinmeyen ama gerekli bilgi için [köşeli parantez] bırak. Gelen maildeki imza, yasal uyarı, alıntı gibi gereksiz şeyleri alma.',
    '- Markanın mail metnini olduğu gibi yapıştırma, ekibin anlayacağı şekilde toparla. Linkleri ve kampanya adlarını değiştirme.',
    '- KURULUM BİLGİLERİNE DOKUNMA: Markanın gönderdiği reklam/kurulum metinlerini ve etiketlerini (Primary text, Headline, Description, LP / landing page, URL, CTA, kampanya/kitle/set adları, UTM, görsel/video adları) mailde nasıl yazıyorsa öyle aktar. Etiketleri Türkçeye çevirme ("Başlık", "Açıklama", "Ana metin" deme), metinleri yeniden yazma, kısaltma, düzeltme. Sadece kendi giriş/açıklama cümlelerini toparla.',
    '',
    attAi.text,
    atts.length ? '- EKLER: Eklerin içeriğine (dosya adı, birlikte geldiği mesaj, görselin kendisi) bakarak o ekibin işi yapmak için GERÇEKTEN ihtiyaç duyduğu ekleri seç ve "attach" listesine ref ile yaz (ör. ["E3","E5"]). Aynı dosyanın eski sürümü yerine en yenisini seç. İmza/logo, ekran görüntüsü olarak sadece bilgi amaçlı paylaşılmış ya da o ekibi ilgilendirmeyen dosyaları seçme (ör. SM ekibine sadece Meta/TikTok kreatifleri, Google ekibine Google için olanlar). Görseller link olarak (WeTransfer, Drive) geldiyse linki açıklamada aynen ver.' : '',
    atts.length ? '- GÖRSEL GÖMME: Ekibin işi doğru anlaması için bir görseli GÖRMESİ gerekiyorsa (reklam önizlemesi, kapatılacak/güncellenecek kampanyanın ekran görüntüsü, kreatif, panel ekranı, tablo görüntüsü) açıklamada o görselin ilgili olduğu cümlenin hemen altına tek başına bir satır olarak [[E2]] yaz (E2 yerine görselin ref\'i). O görsel tam orada açıklamanın içinde gösterilir. Gömdüğün görselleri "attach" listesine de ekle. Gömülmeyen ekler için açıklamada kısaca "Dosyalar ekte." de. Bilgi amaçlı, imza/logo ya da işle ilgisiz görselleri gömme.' : '',
    '',
    'THREAD (kronolojik):',
    convo.join('\n'),
    '',
    'SADECE şu JSON\'u döndür: {"sm": {"relevant": true/false, "title": "...", "body": "...", "reason": "", "attach": ["E1"]}, "google": {"relevant": true/false, "title": "...", "body": "...", "reason": "", "attach": []}}'
  ].join('\n');
  var a = safeJson_(callGemini_(prompt, cfg, attAi.parts));
  var pick = function (x, team) {
    x = x || {}; var body = String(x.body || '').replace(/\r/g, '').trim();
    var rel = x.relevant !== false && !!body;
    var refs = (x.attach || []).map(function (r) { return String(r).trim().toUpperCase(); });
    return { team: team, attach: rel ? atts.filter(function (t) { return refs.indexOf(t.ref) >= 0 || refs.indexOf(String(t.name).toUpperCase()) >= 0; }).map(function (t) { return t.id; }) : [], relevant: rel, title: rel ? jiraTitleFix_(x.title, team) : '', body: rel ? body : '', reason: rel ? '' : String(x.reason || 'Bu işte bu ekibe düşen bir kısım yok.').trim() };
  };
  var out = { tasks: [pick(a.sm, 'SM'), pick(a.google, 'Google')], attachments: atts };
  if (!out.tasks.some(function (t) { return t.relevant; })) throw new Error('AI iki ekip için de metin üretemedi');
  return out;
}
// ============================================================
//  JIRA BAĞLANTISI — task aç / yorum yaz (REST v3, kişisel API token)
//  Token kullanıcıya özel UserProperties'te durur; Claude ya da kod token girmez.
// ============================================================
function jiraSite_() {
  if (!String(getConfig_().JIRA_SITE || '').trim()) throw new Error('Settings sayfasında JIRA_SITE boş (ör. https://firma.atlassian.net).');
  var s = String((getConfig_().JIRA_SITE || '')).trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(s) ? s : 'https://' + s;
}
function jiraCreds_() {
  var up = PropertiesService.getUserProperties();
  var e = up.getProperty('JIRA_EMAIL'), t = up.getProperty('JIRA_TOKEN');
  return e && t ? { email: e, token: t } : null;
}
function jiraFetch_(method, path, body, quiet) {
  var c = jiraCreds_();
  if (!c) throw new Error('Jira bağlı değil. Board\'daki 🧩 kutusundan ya da Sheet menüsünden "Jira\'yı bağla" ile API token gir.');
  var opt = {
    method: method, muteHttpExceptions: true,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(c.email + ':' + c.token), Accept: 'application/json' }
  };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  var res = UrlFetchApp.fetch(jiraSite_() + path, opt), code = res.getResponseCode(), txt = res.getContentText();
  var js = null; try { js = txt ? JSON.parse(txt) : null; } catch (e) {}
  if (code >= 300) {
    if (quiet) return { _err: code, _body: js || txt };
    var msg = js ? [].concat(js.errorMessages || [], Object.keys(js.errors || {}).map(function (k) { return k + ': ' + js.errors[k]; })).join(' · ') : '';
    if (code === 401) msg = 'Jira token geçersiz ya da süresi dolmuş. Yeni token ile tekrar bağla.';
    throw new Error('Jira ' + code + (msg ? ': ' + msg : ''));
  }
  return js;
}
/** Board / menü: kullanıcının kendi girdiği e-posta + API token'ı kaydeder ve test eder */
function jiraConnect(email, token) {
  email = String(email || '').trim(); token = String(token || '').trim();
  if (!email || !token) throw new Error('E-posta ve API token gerekli');
  var up = PropertiesService.getUserProperties(), old = { e: up.getProperty('JIRA_EMAIL'), t: up.getProperty('JIRA_TOKEN') };
  up.setProperties({ JIRA_EMAIL: email, JIRA_TOKEN: token });
  try {
    var me = jiraFetch_('get', '/rest/api/3/myself');
    up.setProperty('JIRA_ACCOUNT', JSON.stringify({ id: me.accountId, name: me.displayName }));
    CacheService.getUserCache().removeAll(['JIRA_HIST', 'JIRA_PROJ']);
    return { ok: true, name: me.displayName };
  } catch (e) {
    if (old.e && old.t) up.setProperties({ JIRA_EMAIL: old.e, JIRA_TOKEN: old.t }); else { up.deleteProperty('JIRA_EMAIL'); up.deleteProperty('JIRA_TOKEN'); }
    throw e;
  }
}
function jiraDisconnect() {
  var up = PropertiesService.getUserProperties();
  ['JIRA_EMAIL', 'JIRA_TOKEN', 'JIRA_ACCOUNT'].forEach(function (k) { up.deleteProperty(k); });
  return true;
}
function promptJira() {
  var ui = SpreadsheetApp.getUi(), cfg = getConfig_();
  var a = ui.prompt('Jira bağla (1/2)', 'Jira\'ya giriş yaptığın e-posta (boş bırakırsan ' + cfg.MY_EMAIL + '):', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var b = ui.prompt('Jira bağla (2/2)', 'id.atlassian.com/manage-profile/security/api-tokens adresinden "Create API token" ile aldığın token\'ı yapıştır:', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  try { var r = jiraConnect(a.getResponseText().trim() || cfg.MY_EMAIL, b.getResponseText()); ui.alert('Jira bağlandı: ' + r.name); }
  catch (e) { ui.alert('Bağlanamadı: ' + e.message); }
}
function jiraSearch_(jql, fields, max) {
  var r = jiraFetch_('post', '/rest/api/3/search/jql', { jql: jql, maxResults: max || 50, fields: fields });
  return (r && r.issues) || [];
}
// ---------- Jira task başlığı formatı ----------
// Ekibin Jira'da yerleşik kullandığı yapı (ORNPERF, ORNEXP, GRPADS, XYZADS, MRKD, CCM, CHIC… başlıklarından):
//   "<Marka kısa adı> | <İş> - <Kanal>"           ör. "Marka B | Flash %60 - SM", "Grup Marka | CRM Kitleleri - Google"
//   "<Marka kısa adı> | <İş> - <Ay Yıl> - <Kanal>" ör. "ÖRN MO | PMax Harcama Kontrolü - Ekim 2026 - Google"
// Kanal en sonda (SM / Google / DV360, etiketle aynı). "Kampanyası/Kampanyaları" eki kullanılmaz.
var JIRA_TITLE_RULE_ = [
  'BAŞLIK FORMATI (ekibin Jira\'daki yerleşik yapısı, zorunlu):',
  '- "<Marka kısa adı> | <İş> - <Kanal>". Kanal EN SONDA: SM task\'inde "SM", Google task\'inde "Google".',
  '- İş belli bir döneme/aya bağlıysa (kampanya dönemi, aylık takip, aylık bütçe) kanaldan önce ay ekle: "<Marka> | <İş> - <Ay Yıl> - <Kanal>" (ör. "Ekim 2026"). Döneme bağlı değilse ay yazma.',
  '- Marka kısa adını bu projenin son başlıklarından al (ör. ÖRN, ÖRN Export, ÖRN RO, Marka B, Marka C, Marka E, Grup Marka, TG, Marka D). Ülke ya da alt marka varsa marka kısmına yaz ("ÖRN RO", "ÖRN MO").',
  '- <İş>: 2-7 kelime, işin/kampanyanın kendi adı, markanın kullandığı ifadeyle (ör. "Flash %60", "Outlet %70\'e varan + 3 ürün %40", "PMax Video Güncellemeleri", "CRM Kitleleri", "Bütçe & KPI").',
  '- "Kampanyası", "Kampanyaları" eki ya da kelimesi KULLANMA ("Flash Kampanyası" değil "Flash", "Brand Kampanyası" değil "Brand", "Install Kampanyası" değil "Install").',
  '- İki ekibin başlığı kanal hariç birebir aynı olsun. Tırnak, emoji, sonda nokta yok. Bilmediğin parçayı uydurma.',
  'ÖRNEKLER: "Marka B | Flash %60 - SM" · "Marka C | Final Sale 2 ürün 70 - Google" · "ÖRN RO | Summer Season App15 - Google" · "ÖRN Export | Extra 15 Install - Ekim 2026 - SM" · "Grup Marka | IBQML Kitleleri - Google"'
].join('\n');
/** AI başlığını formata oturt: "Kampanyası" eklerini at, ayraçları düzelt, kanal sonda olsun */
function jiraTitleFix_(t, team) {
  t = String(t || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '');
  if (!t) return '';
  t = t.replace(/\s*\bkampanya(lar[ıi]|s[ıi])(?=$|[\s\-|,])/gi, '');   // JS \b Türkçe ı'yı harf saymaz → lookahead
  var ch = team === 'SM' ? 'SM' : team === 'Google' ? 'Google' : '';
  if (ch) {
    // "Marka - SM - İş - Ay" (eski yapay format) → kanal parçasını ortadan çıkar, sona koy
    var parts = t.split(/\s+-\s+/);
    var rest = parts.filter(function (p) { return !/^(sm|google|meta|google ads|sosyal medya)$/i.test(p.trim()); });
    if (rest.length !== parts.length || !new RegExp('-\\s*' + ch + '$', 'i').test(t)) {
      t = rest.join(' - ');
      if (t.indexOf('|') < 0 && rest.length >= 2) t = rest[0] + ' | ' + rest.slice(1).join(' - ');
      t = t + ' - ' + ch;
    }
  }
  return t.replace(/\s+-\s+-\s+/g, ' - ').replace(/\s{2,}/g, ' ').trim();
}
/** Markanın Jira projesindeki son başlıklar (6 saat cache). AI'ın eski "<Marka> - SM - …" ve "Kampanyası" örnekleri ayıklanır. */
function jiraTitleExamples_(brand, threadId) {
  try {
    var key = '';
    try { key = jiraPickProject_(brand, jiraHistory_(), jiraProjects_(), '', threadId).key || ''; } catch (e) {}
    if (!key) return [];
    var cache = CacheService.getUserCache(), ck = 'JTITLE_' + key, hit = cache.get(ck);
    var list = hit ? JSON.parse(hit) : jiraSearch_('project = "' + key + '" AND created >= -180d ORDER BY created DESC', ['summary'], 60).map(function (i) { return String((i.fields || {}).summary || '').trim(); });
    if (!hit) { try { cache.put(ck, JSON.stringify(list), 21600); } catch (e) {} }
    var seen = {};
    return list.filter(function (t) {
      if (!t || /\s-\s(SM|Google)\s-\s/.test(t) || /kampanyas[ıi]|kampanyalar[ıi]/i.test(t)) return false;
      var k = t.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true;
    }).slice(0, 25);
  } catch (e) { return []; }
}
/** Son 120 günde benim açtığım işler: proje, etiket, atanan, başlık (30 dk cache) */
function jiraHistory_() {
  var cache = CacheService.getUserCache(), hit = cache.get('JIRA_HIST');
  if (hit) return JSON.parse(hit);
  var out = jiraSearch_('reporter = currentUser() AND created >= -120d ORDER BY created DESC', ['summary', 'project', 'labels', 'assignee', 'issuetype'], 100).map(function (i) {
    var f = i.fields || {};
    return { key: i.key, s: f.summary || '', p: f.project && f.project.key, pn: f.project && f.project.name, l: f.labels || [],
      a: f.assignee ? { id: f.assignee.accountId, n: f.assignee.displayName } : null, t: f.issuetype && f.issuetype.name };
  });
  try { cache.put('JIRA_HIST', JSON.stringify(out), 1800); } catch (e) {}
  return out;
}
function jiraProjects_() {
  var cache = CacheService.getUserCache(), hit = cache.get('JIRA_PROJ');
  if (hit) return JSON.parse(hit);
  var out = [];
  for (var start = 0; start < 1000; start += 100) {
    var r = jiraFetch_('get', '/rest/api/3/project/search?action=create&maxResults=100&startAt=' + start);
    (r.values || []).forEach(function (p) { out.push({ k: p.key, n: p.name }); });
    if (r.isLast || !(r.values || []).length) break;
  }
  try { cache.put('JIRA_PROJ', JSON.stringify(out), 21600); } catch (e) {}
  return out;
}
// Ekip etiketleri: Settings > JIRA_TEAM_LABELS (ör. "SM=Sosyal_Medya, Google=Google_Ads"). Boşsa etiket eklenmez.
function jiraTeamLabels_() { var o = {}; try { String(getConfig_().JIRA_TEAM_LABELS || '').split(',').forEach(function (p) { var kv = p.split('='); if (kv[1]) o[kv[0].trim()] = kv[1].trim(); }); } catch (e) {} return o; }
var JIRA_KEY_RE_ = /\b([A-Z][A-Z0-9]{1,14}-\d{1,7})\b/;
// ---------- Marka / iş → Jira projesi eşleştirmesi ----------
// Sheet "JiraProjeleri": A = marka (virgülle diğer adları), B = Jira proje anahtarı, C = son güncelleme.
// Board'da bir kartta proje seçilince: o iş (thread) + kartın markası bu projeye bağlanır; sonraki kartlarda otomatik gelir.
function jiraMapSheet_() {
  var ss = ss_(), sh = ss.getSheetByName(SHEET_JIRA);
  if (!sh) {
    sh = ss.insertSheet(SHEET_JIRA);
    sh.getRange(1, 1, 1, 3).setValues([['Marka (virgülle diğer adları)', 'Jira Projesi', 'Son güncelleme']]).setFontWeight('bold');
    sh.setFrozenRows(1); sh.setColumnWidth(1, 280);
    // Eski öğrenilmiş eşleşmeleri taşı
    try {
      var old = JSON.parse(PropertiesService.getUserProperties().getProperty('JIRA_BRAND_MAP') || '{}');
      var rows = Object.keys(old).map(function (b) { return [b, old[b], new Date()]; });
      if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);
    } catch (e) {}
  }
  return sh;
}
function jiraMapRows_() {
  var sh = jiraMapSheet_(), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, 2).getValues().map(function (r, i) {
    return { row: i + 2, names: String(r[0] || '').split(',').map(fold_).map(function (x) { return x.trim(); }).filter(String), key: String(r[1] || '').trim().toUpperCase() };
  }).filter(function (x) { return x.names.length && x.key; });
}
/** Markaya kayıtlı proje: tam eşleşme, yoksa markanın içinde geçen en uzun ad */
function jiraMapFind_(brand) {
  var fb = fold_(brand).trim(); if (!fb) return '';
  var rows = jiraMapRows_(), best = '', bestLen = 0;
  for (var i = 0; i < rows.length; i++) if (rows[i].names.indexOf(fb) >= 0) return rows[i].key;
  rows.forEach(function (r) { r.names.forEach(function (n) { if (n.length >= 3 && n.length > bestLen && fb.indexOf(n) >= 0) { best = r.key; bestLen = n.length; } }); });
  return best;
}
function jiraMapSet_(brand, key) {
  var fb = fold_(brand).trim(); if (!fb || !key) return;
  var sh = jiraMapSheet_(), rows = jiraMapRows_();
  for (var i = 0; i < rows.length; i++) if (rows[i].names.indexOf(fb) >= 0) { sh.getRange(rows[i].row, 2, 1, 2).setValues([[key, new Date()]]); return; }
  sh.appendRow([String(brand).trim(), key, new Date()]);
}
function jiraThreadMap_() { try { return JSON.parse(PropertiesService.getUserProperties().getProperty('JIRA_THREAD_MAP') || '{}'); } catch (e) { return {}; } }
/** Board: kartta Jira projesi seçildi → bu işin ve markanın projesi olarak kaydet */
function setJiraProject(threadId, key) {
  key = String(key || '').trim().toUpperCase().split(/[\s—-]/)[0];
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(key)) throw new Error('Geçersiz proje anahtarı');
  var up = PropertiesService.getUserProperties(), tm = jiraThreadMap_(), id = String(threadId);
  delete tm[id]; tm[id] = key;
  var ids = Object.keys(tm); if (ids.length > 400) ids.slice(0, ids.length - 400).forEach(function (k) { delete tm[k]; });
  up.setProperty('JIRA_THREAD_MAP', JSON.stringify(tm));
  var row = loadDb_().byId[id], brand = row && row.brand ? String(row.brand) : '';
  if (brand) jiraMapSet_(brand, key);
  return { key: key, brand: brand };
}
function openJiraMap() {
  var sh = jiraMapSheet_(); SpreadsheetApp.setActiveSheet(sh);
}
/** Kartın Jira projesi: konu anahtarı → bu işte seçilen → eşleştirme tablosu → tahmin (proje adı + kullanım sıklığı) */
function jiraGuessProject_(brand, hist, projects, subjKey, threadId) {
  return jiraPickProject_(brand, hist, projects, subjKey, threadId).key;
}
function jiraPickProject_(brand, hist, projects, subjKey, threadId) {
  if (subjKey) return { key: subjKey.split('-')[0], src: 'subject' };
  var tk = threadId ? jiraThreadMap_()[String(threadId)] : '';
  if (tk) return { key: tk, src: 'thread' };
  var mk = ''; try { mk = jiraMapFind_(brand); } catch (e) {}
  if (mk) return { key: mk, src: 'config' };
  return { key: jiraGuessByName_(brand, hist, projects), src: 'guess' };
}
function jiraGuessByName_(brand, hist, projects) {
  var fb = fold_(brand);
  var use = {}; hist.forEach(function (h, i) { use[h.p] = (use[h.p] || 0) + 1 + (hist.length - i) / 1000; });
  if (!fb) return '';
  var toks = fb.split(/[^a-z0-9]+/).filter(function (t) { return t.length >= 2; });
  var best = '', bestScore = 0;
  projects.forEach(function (p) {
    var fn = fold_(p.n).replace(/&/g, ''), fk = fold_(p.k), sc = 0;
    toks.forEach(function (t) { if (fn.indexOf(t) >= 0) sc += 10; if (fk.indexOf(t) === 0) sc += 6; });
    if (fn.replace(/[^a-z0-9]/g, '').indexOf(fb.replace(/[^a-z0-9]/g, '')) >= 0) sc += 15;
    if (!sc) return;
    if (/marketing/.test(fn)) sc += 3;
    if (/\[(seo|data|pmo)\]/.test(fn)) sc -= 8;
    if (/perform|perads/.test(fn + ' ' + fk)) sc += 2;
    sc += Math.min(use[p.k] || 0, 20);
    if (sc > bestScore) { bestScore = sc; best = p.k; }
  });
  return best;
}
/** Board: Jira kutusu açılınca bağlam (bağlı mı, projeler, öneriler, atanan adayları, yorum hedefleri) */
function getJiraContext(threadId) {
  var c = jiraCreds_(), site = jiraSite_();
  if (!c) return { connected: false, site: site, email: getConfig_().MY_EMAIL };
  var db = loadDb_(), row = db.byId[String(threadId)] || {};
  var subj = String(row.subject || ''), mk = subj.match(JIRA_KEY_RE_);
  var hist = jiraHistory_(), projects = [];
  try { projects = jiraProjects_(); } catch (e) {}
  var subjKey = mk ? mk[1] : '';
  var pick = jiraPickProject_(row.brand, hist, projects, subjKey, threadId), proj = pick.key;
  // proje+etiket bazında son atananlar
  var people = {}, TL = jiraTeamLabels_();
  hist.forEach(function (h) {
    if (!h.a) return;
    var team = ''; Object.keys(TL).forEach(function (t) { if (!team && h.l.indexOf(TL[t]) >= 0) team = t; });
    var k = h.p + '|' + team;
    (people[k] = people[k] || []);
    if (!people[k].some(function (x) { return x.id === h.a.id; })) people[k].push(h.a);
  });
  var recentProj = []; hist.forEach(function (h) { if (recentProj.indexOf(h.p) < 0) recentProj.push(h.p); });
  var targets = [];
  try {
    targets = jiraSearch_('(reporter = currentUser() OR assignee = currentUser() OR watcher = currentUser()) AND updated >= -45d ORDER BY updated DESC', ['summary', 'labels'], 40)
      .map(function (i) { return { key: i.key, s: i.fields.summary, team: jiraTeamOf_(i.fields.summary, i.fields.labels) }; });
  } catch (e) {}
  if (subjKey && !targets.some(function (t) { return t.key === subjKey; })) targets.unshift({ key: subjKey, s: subj.replace(/^\s*\[JIRA\]\s*/i, '') });
  // Mail kartı: yorum yazılacak task'i kendiliğinden öner (Jira kartında marka mailini seçmenin tersi)
  var sug = subjKey ? null : jiraSuggestTask_(threadId, row, targets, proj);
  if (sug) { targets = targets.filter(function (t) { return t.key !== sug.key; }); targets.unshift({ key: sug.key, s: sug.s }); }
  // Ekip başına öneri (SM ve Google yorum kutuları): konudaki anahtar kendi ekibine; her ekip için kendi task'leri arasından en olası olan
  var suggest = {};
  var subjTeam = subjKey ? ((targets.filter(function (t) { return t.key === subjKey; })[0] || {}).team || 'SM') : '';
  if (subjKey) suggest[subjTeam] = { key: subjKey, why: 'mailin konusundaki task' };
  ['SM', 'Google'].forEach(function (tm) {
    if (suggest[tm]) return;
    var other = tm === 'SM' ? 'Google' : 'SM', taken = suggest[other] ? suggest[other].key : '';
    var cand = targets.filter(function (t) { return t.team === tm && t.key !== taken; });
    var sg2 = cand.length ? jiraSuggestTask_(threadId, row, cand, proj) : null;
    if (sg2) suggest[tm] = { key: sg2.key, why: sg2.why };
  });
  var me = {}; try { me = JSON.parse(PropertiesService.getUserProperties().getProperty('JIRA_ACCOUNT') || '{}'); } catch (e) {}
  return { connected: true, suggest: suggest, site: site, me: me.name || c.email, brand: row.brand || '', project: proj, projectSrc: pick.src, subjectKey: subjKey, teams: splitList_(getConfig_().JIRA_TEAMS || ''),
    commentStatus: String(getConfig_().JIRA_COMMENT_STATUS || '').trim(), commentDue: isTrue_(getConfig_().JIRA_COMMENT_DUE_TODAY),
    recentProjects: recentProj.slice(0, 15), projects: projects, people: people, targets: targets.slice(0, 40),
    suggestKey: sug ? sug.key : '', suggestWhy: sug ? sug.why : '' };
}
/**
 * Bu mail için en olası Jira task'i:
 *  +100 bu mailden açılan / bu mailden yorum yazılan task (JIRA_ISSUE_THREADS)
 *  +60  mailde (konu, özet, hafıza) task anahtarı geçiyor
 *  +20  task markanın Jira projesinde
 *  +5   task başlığı ile mail konusu/başlığı arasında ortak her anlamlı kelime
 *  En yüksek puan 25+ ise önerilir (proje + en az bir ortak kelime ya da bağlantı).
 */
function jiraSuggestTask_(threadId, row, targets, proj) {
  var id = String(threadId), linked = [], map = jiraIssueThreads_();
  Object.keys(map).forEach(function (k) { if (String(map[k]) === id) linked.push(k); });
  var text = [row.subject, row.title, row.summary, row.memory, row.nextAction].join(' ');
  var inText = (text.match(/\b[A-Z][A-Z0-9]{1,14}-\d{1,7}\b/g) || []);
  var STOP = { 'icin': 1, 'ile': 1, 'olan': 1, 'reklam': 1, 'reklamlari': 1, 'kampanya': 1, 'kampanyasi': 1, 'kampanyalari': 1, 'hakkinda': 1, 'guncelleme': 1, 'talep': 1, 'google': 1, 'meta': 1, 'and': 1, 'the': 1, 'for': 1 };
  var toks = foldTr_([row.subject, row.title].join(' ')).split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 4 && !STOP[w]; });
  var cands = targets.slice();
  linked.concat(inText).forEach(function (k) { if (!cands.some(function (t) { return t.key === k; })) cands.push({ key: k, s: '' }); });
  var best = null;
  cands.forEach(function (t, idx) {
    var sc = 0, why = [];
    if (linked.indexOf(t.key) >= 0) { sc += 100; why.push('bu mailden açılan/yorum yazılan task'); }
    if (inText.indexOf(t.key) >= 0) { sc += 60; why.push('mailde task numarası geçiyor'); }
    if (proj && t.key.split('-')[0] === proj) { sc += 20; why.push(proj + ' projesi'); }
    var hay = foldTr_(t.s || ''), hit = toks.filter(function (w) { return hay.indexOf(w) >= 0; });
    if (hit.length) { sc += 5 * hit.length; why.push('başlıkta ortak: ' + hit.slice(0, 3).join(', ')); }
    sc -= idx * 0.01;   // eşitlikte daha yakın zamanda güncellenen
    if (!best || sc > best.sc) best = { key: t.key, s: t.s, sc: sc, why: why.join(' · ') };
  });
  return best && best.sc >= 25 ? best : null;
}
function jiraIssueSearch(q) {
  q = String(q || '').trim(); if (!q) return [];
  var m = q.toUpperCase().match(JIRA_KEY_RE_);
  if (m) { var i = jiraFetch_('get', '/rest/api/3/issue/' + m[1] + '?fields=summary', null, true); return i && !i._err ? [{ key: i.key, s: i.fields.summary }] : []; }
  return jiraSearch_('summary ~ "' + q.replace(/["\\]/g, '') + '*" AND updated >= -180d ORDER BY updated DESC', ['summary'], 15)
    .map(function (i) { return { key: i.key, s: i.fields.summary }; });
}
/** Düz metni Jira ADF'ye çevir: boş satır = paragraf, "-"/"•" satırları = madde, URL'ler link */
function textToAdf_(text, mentions) {
  var mnames = Object.keys(mentions || {}).sort(function (x, y) { return y.length - x.length; });
  var withMentions = function (str) {          // "@Ad Soyad" → Jira mention düğümü (kişi bildirim alır)
    if (!mnames.length) return [{ type: 'text', text: str }];
    var out = [], rest = str;
    while (rest) {
      var best = -1, nm = '';
      mnames.forEach(function (n) { var k = rest.indexOf('@' + n); if (k >= 0 && (best < 0 || k < best)) { best = k; nm = n; } });
      if (best < 0) { out.push({ type: 'text', text: rest }); break; }
      if (best > 0) out.push({ type: 'text', text: rest.slice(0, best) });
      out.push({ type: 'mention', attrs: { id: mentions[nm], text: '@' + nm } });
      rest = rest.slice(best + nm.length + 1);
    }
    return out;
  };
  var inline = function (s) {
    var out = [], re = /https?:\/\/[^\s<>()]+/g, last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out = out.concat(withMentions(s.slice(last, m.index)));
      var u = m[0].replace(/[.,;:]+$/, '');
      out.push({ type: 'text', text: u, marks: [{ type: 'link', attrs: { href: u } }] });
      last = m.index + u.length; re.lastIndex = last;
    }
    if (last < s.length) out = out.concat(withMentions(s.slice(last)));
    return out;
  };
  var content = [], para = [], bullets = [];
  var flushP = function () { if (para.length) { var c = []; para.forEach(function (l, i) { if (i) c.push({ type: 'hardBreak' }); c = c.concat(inline(l)); }); content.push({ type: 'paragraph', content: c }); para = []; } };
  var flushB = function () { if (bullets.length) { content.push({ type: 'bulletList', content: bullets.map(function (b) { return { type: 'listItem', content: [{ type: 'paragraph', content: inline(b) }] }; }) }); bullets = []; } };
  String(text || '').replace(/\r/g, '').split('\n').forEach(function (ln) {
    var t = ln.replace(/\s+$/, ''), b = t.match(/^\s*[-•*]\s+(.+)$/);
    if (!t.trim()) { flushP(); flushB(); }
    else if (b) { flushP(); bullets.push(b[1]); }
    else { flushB(); para.push(t.trim()); }
  });
  flushP(); flushB();
  if (!content.length) content.push({ type: 'paragraph', content: [] });
  return { type: 'doc', version: 1, content: content };
}
/** Board: Jira'da task aç (onay board'da iki adımlı) */
function createJiraIssue(threadId, team, projectKey, summary, body, assigneeId, mentions, attachments) {
  projectKey = String(projectKey || '').trim().toUpperCase().split(/[\s—-]/)[0];
  summary = String(summary || '').replace(/\s+/g, ' ').trim();
  if (!projectKey) throw new Error('Proje seç');
  if (!summary) throw new Error('Başlık boş');
  var embeds = embedRefsOf_(body);
  attachments = jiraWithEmbeds_(attachments, embeds, threadId);
  var fields = { project: { key: projectKey }, summary: summary.slice(0, 250), description: textToAdf_(stripEmbeds_(body), mentions) };
  var label = JIRA_TEAM_LABEL_[team]; if (label) fields.labels = [label];
  if (assigneeId) fields.assignee = { accountId: assigneeId };
  // Tarihler + ekip: Start date ve Due date bugün, Teams ayarlardan (JIRA_TEAMS, ör. Hera)
  var cfg = getConfig_(), today = Utilities.formatDate(new Date(), 'Europe/Istanbul', 'yyyy-MM-dd');
  var optional = [];
  fields.duedate = today; optional.push('duedate');
  var sf = String(cfg.JIRA_START_FIELD || '').trim(); if (sf) { fields[sf] = today; optional.push(sf); }
  var tf = String(cfg.JIRA_TEAMS_FIELD || '').trim(), tv = splitList_(cfg.JIRA_TEAMS || '');
  if (tf && tv.length) { fields[tf] = tv.map(function (v) { return { value: v }; }); optional.push(tf); }
  var tryCreate = function (typeRef) { fields.issuetype = typeRef; return jiraFetch_('post', '/rest/api/3/issue', { fields: fields }, true); };
  var r = tryCreate({ name: 'Task' });
  if (r && r._err === 400 && JSON.stringify(r._body || '').toLowerCase().indexOf('issuetype') >= 0) {
    var meta = jiraFetch_('get', '/rest/api/3/issue/createmeta/' + encodeURIComponent(projectKey) + '/issuetypes');
    var types = (meta.issueTypes || meta.values || []).filter(function (t) { return !t.subtask; });
    var pick = types.filter(function (t) { return /task|görev/i.test(t.name); })[0] || types[0];
    if (!pick) throw new Error('Bu projede task tipi bulunamadı');
    r = tryCreate({ id: pick.id });
  }
  if (r && r._err === 400 && assigneeId && JSON.stringify(r._body || '').indexOf('assignee') >= 0) { delete fields.assignee; r = jiraFetch_('post', '/rest/api/3/issue', { fields: fields }, true); }
  // Bu projenin ekranında tarih/Teams alanı yoksa (ya da değer geçersizse) o alanları çıkarıp tekrar dene
  if (r && r._err === 400 && r._body && r._body.errors) {
    var bad = optional.filter(function (k) { return r._body.errors[k]; });
    if (bad.length) { bad.forEach(function (k) { delete fields[k]; }); log_('WARN', 'Jira ' + projectKey + ': ' + bad.join(', ') + ' alan(lar)ı ayarlanamadı, onlarsız açıldı'); r = jiraFetch_('post', '/rest/api/3/issue', { fields: fields }, true); }
  }
  if (r && r._err) throw new Error('Jira ' + r._err + ': ' + JSON.stringify(r._body).slice(0, 300));
  // marka → proje eşleşmesini öğren, cache'i tazele
  try {
    setJiraProject(threadId, projectKey);
    jiraIssueThreadSet_(r.key, threadId);
    CacheService.getUserCache().remove('JIRA_HIST');
  } catch (e) {}
  var up = uploadJiraAttachments_(r.key, attachments, embeds);
  if ((embeds.length && Object.keys(up.names).length) || hasRich_(body)) {
    var wr = jiraFetch_('put', '/rest/api/2/issue/' + r.key, { fields: { description: textToWiki_(body, mentions, up.names, up.dims) } }, true);
    if (!(wr && wr._err)) {
      try {
        var ig = jiraFetch_('get', '/rest/api/3/issue/' + r.key + '?fields=description', null, true), dsc = ig && ig.fields && ig.fields.description;
        if (dsc && jiraMediaDimsFix_(dsc, embedDimsSeq_(body, up))) jiraFetch_('put', '/rest/api/3/issue/' + r.key, { fields: { description: dsc } }, true);
      } catch (e) { log_('WARN', 'Açıklama görsel boyutu düzeltilemedi ' + r.key + ': ' + e); }
    }
    if (wr && wr._err) { up.errors.push('Görseller açıklamaya gömülemedi (ekler task\'te): Jira ' + wr._err); log_('WARN', 'Jira açıklama (wiki) güncellenemedi ' + r.key + ': ' + JSON.stringify(wr._body).slice(0, 300)); }
  }
  return { key: r.key, url: jiraSite_() + '/browse/' + r.key, uploaded: up.ok, uploadErrors: up.errors, embedded: Object.keys(up.names).length };
}
/** Board (Jira kartı): task'in şu anki durumu ve gidebileceği durumlar */
function getJiraTransitions(issueKey) {
  var m = String(issueKey || '').toUpperCase().match(JIRA_KEY_RE_);
  if (!m) throw new Error('Geçerli bir iş anahtarı yok');
  var cur = jiraFetch_('get', '/rest/api/3/issue/' + m[1] + '?fields=status,assignee');
  var f = cur.fields || {};
  var tr = jiraFetch_('get', '/rest/api/3/issue/' + m[1] + '/transitions').transitions || [];
  return { key: m[1], url: jiraSite_() + '/browse/' + m[1], status: (f.status && f.status.name) || '', assignee: (f.assignee && f.assignee.displayName) || '',
    transitions: tr.map(function (t) { return { id: t.id, name: t.name, to: (t.to && t.to.name) || '' }; }) };
}
/** Board (Jira kartı): task'in durumunu değiştir (seçilen geçişi uygula) */
function setJiraStatus(issueKey, transitionId, threadId) {
  var m = String(issueKey || '').toUpperCase().match(JIRA_KEY_RE_);
  if (!m) throw new Error('Geçerli bir iş anahtarı yok');
  if (!transitionId) throw new Error('Durum seç');
  jiraFetch_('post', '/rest/api/3/issue/' + m[1] + '/transitions', { transition: { id: String(transitionId) } });
  var out = getJiraTransitions(m[1]);
  if (threadId) {
    try {
      var lock = LockService.getUserLock(); lock.waitLock(15000);
      try {
        var db = loadDb_(), row = db.byId[String(threadId)];
        if (row && (/(^|,)JIRA(,|$)/.test(String(row.flags || '')) || isJiraStatus_(row.status))) {
          if (applyJiraStage_(row, jiraStageOf_(m[1], true))) { saveRow_(db, row); flushDb_(db); try { applyBoardLabels_(apiThread_(row.threadId), row, getConfig_()); } catch (e) {} }
          out.card = toCard_(row);
        }
      } finally { lock.releaseLock(); }
    } catch (e) { log_('WARN', 'Jira durumu sonrası kart güncellenemedi: ' + e); }
  }
  return out;
}
/** Board: mevcut bir Jira işine yorum yaz (mentions: {"Ad Soyad": accountId} → "@Ad Soyad" gerçek etiket olur) */
function addJiraComment(issueKey, body, mentions, attachments, threadId) {
  var m = String(issueKey || '').toUpperCase().match(JIRA_KEY_RE_);
  if (!m) throw new Error('Geçerli bir iş anahtarı gir (ör. GRPADS-2219)');
  if (!String(body || '').trim()) throw new Error('Yorum boş');
  var embeds = embedRefsOf_(body);
  attachments = jiraWithEmbeds_(attachments, embeds, threadId);
  var up = uploadJiraAttachments_(m[1], attachments, embeds);
  var r = null;
  if ((embeds.length && Object.keys(up.names).length) || hasRich_(body)) {
    r = jiraFetch_('post', '/rest/api/2/issue/' + m[1] + '/comment', { body: textToWiki_(body, mentions, up.names, up.dims) }, true);
    if (r && !r._err && r.id) {
      try {
        var cp = '/rest/api/3/issue/' + m[1] + '/comment/' + r.id, cg = jiraFetch_('get', cp, null, true);
        if (cg && cg.body && jiraMediaDimsFix_(cg.body, embedDimsSeq_(body, up))) jiraFetch_('put', cp, { body: cg.body }, true);
      } catch (e) { log_('WARN', 'Yorum görsel boyutu düzeltilemedi ' + m[1] + ': ' + e); }
    }
    if (r && r._err) { log_('WARN', 'Jira yorumu (wiki) yazılamadı ' + m[1] + ', düz yoruma geçildi: ' + JSON.stringify(r._body).slice(0, 300)); up.errors.push('Görseller yoruma gömülemedi (ekler task\'te)'); r = null; }
  }
  if (!r) r = jiraFetch_('post', '/rest/api/3/issue/' + m[1] + '/comment', { body: textToAdf_(stripEmbeds_(body).replace(/\*\*([^*\n]+)\*\*/g, '$1'), mentions) });
  var after = jiraAfterComment_(m[1]);
  // Jira bildirimi kartından yorum: kartın durumunu SON yorumumun içeriği belirler (ekibe iş verdim → CM/ekip cevabı, markadan bekleniyor → Markada, üstlendim → Devam, kapandı → Tamamlandı, bilgi → Jira).
  // Marka mailinden yorum: Jira işi ↔ marka maili eşleşmesi kaydedilir (Jira kartından "Markaya dön" için)
  var card = null, effect = '';
  if (threadId) {
    try {
      var row0 = loadDb_().byId[String(threadId)];
      var isJ = row0 && (/(^|,)JIRA(,|$)/.test(String(row0.flags || '')) || isJiraStatus_(row0.status) || isJiraStatus_(row0.aiStatus));
      if (row0 && !isJ) { jiraIssueThreadSet_(m[1], threadId); card = toCard_(row0); }
      if (isJ) {
        var cfgC = getConfig_(), stC = null; try { stC = jiraIssueState_(m[1], 1); } catch (e) {}
        effect = jiraCommentEffect_(body, cfgC, stC);
        jiraMyCommentSet_(threadId, m[1], effect);
        var lock = LockService.getUserLock(); lock.waitLock(15000);
        try {
          var db = loadDb_(), row = db.byId[String(threadId)];
          if (row && !isTrue_(row.closed) && !isSticky_(row.manualStatus)) {
            var ns = JIRA_COMMENT_EFFECT_[effect] || 'JIRA';
            row.status = ns; row.aiStatus = ns; row.manualStatus = ''; row.followUp = false; row.suggestedReply = '';
            row.priorityReason = (JIRA_COMMENT_REASON_[effect] || 'Jira yorumun') + ' (' + m[1] + ')'; row.updatedAt = new Date().toISOString();
            if (ns === 'JIRA' && effect !== 'DELEGATED') { try { applyJiraStage_(row, jiraStageOf_(m[1], true)); } catch (e) {} }
            saveRow_(db, row); flushDb_(db);
            try { applyBoardLabels_(apiThread_(row.threadId), row, cfgC); } catch (e) {}
          }
          if (row) card = toCard_(row);
        } finally { lock.releaseLock(); }
      }
    } catch (e) { log_('WARN', 'Jira yorumu sonrası kart güncellenemedi: ' + e); }
  }
  return { key: m[1], url: jiraSite_() + '/browse/' + m[1] + '?focusedCommentId=' + r.id, uploaded: up.ok, uploadErrors: up.errors, card: card, effect: effect,
    status: after.status, due: after.due, afterErrors: after.errors };
}
/** Yorumdan sonra: task'i JIRA_COMMENT_STATUS durumuna (ör. To Do) al ve Due date'i bugün yap. Hatalar yorumu bozmaz, sadece bildirilir. */
function jiraAfterComment_(key) {
  var cfg = getConfig_(), out = { status: '', due: '', errors: [] };
  var target = String(cfg.JIRA_COMMENT_STATUS || '').trim();
  if (target) {
    try {
      var cur = jiraFetch_('get', '/rest/api/3/issue/' + key + '?fields=status');
      var curName = (cur.fields && cur.fields.status && cur.fields.status.name) || '';
      if (fold_(curName) === fold_(target)) out.status = curName;
      else {
        var tr = (jiraFetch_('get', '/rest/api/3/issue/' + key + '/transitions').transitions || []);
        var pick = tr.filter(function (t) { return t.to && fold_(t.to.name) === fold_(target); })[0] || tr.filter(function (t) { return fold_(t.name) === fold_(target); })[0];
        if (!pick && /^to ?do$/i.test(target)) pick = tr.filter(function (t) { return t.to && t.to.statusCategory && t.to.statusCategory.key === 'new'; })[0];
        if (pick) { jiraFetch_('post', '/rest/api/3/issue/' + key + '/transitions', { transition: { id: pick.id } }); out.status = (pick.to && pick.to.name) || target; }
        else out.errors.push('"' + target + '" durumuna geçiş yok (şu an: ' + curName + ')');
      }
    } catch (e) { out.errors.push('durum: ' + (e.message || e)); }
  }
  if (isTrue_(cfg.JIRA_COMMENT_DUE_TODAY)) {
    try {
      var today = Utilities.formatDate(new Date(), 'Europe/Istanbul', 'yyyy-MM-dd');
      jiraFetch_('put', '/rest/api/3/issue/' + key, { fields: { duedate: today } });
      out.due = today;
    } catch (e) { out.errors.push('due date: ' + (e.message || e)); }
  }
  return out;
}
/** Board: mail thread'indeki ekler ve görseller (Jira'ya yüklenebilecekler). İmza logoları gibi küçük gömülü görseller hariç. */
function getThreadAttachments(threadId) {
  var th = apiThread_(String(threadId)); if (!th || !th.exists()) return [];
  var cfg = getConfig_(), out = [], seen = {}, msgs = th.getMessages().filter(function (m) { return !m.isDraft(); });
  msgs.forEach(function (m, mi) {
    var from = (parseAddresses_(m.getFrom())[0] || {}), date = m.getDate(), snippet = null;
    var getSnippet = function () {
      if (snippet === null) { try { snippet = cleanBody_(m.getPlainBody ? m.getPlainBody() : '').replace(/\s+/g, ' ').slice(0, 220); } catch (e) { snippet = ''; } }
      return snippet;
    };
    (function walk(p) {
      if (!p) return;
      var mime = lc_(p.mimeType || ''), attId = p.body && p.body.attachmentId, size = (p.body && p.body.size) || 0, hd = {};
      (p.headers || []).forEach(function (h) { hd[lc_(h.name)] = h.value; });
      var cd = String(hd['content-disposition'] || ''), isImg = mime.indexOf('image/') === 0;
      var inline = /inline/i.test(cd) || (!!hd['content-id'] && !/attachment/i.test(cd));
      if (attId && (p.filename || isImg) && mime.indexOf('multipart/') !== 0 && mime !== 'text/calendar' && mime !== 'application/ics') {
        var logo = isImg && (size < 4000 || (inline && size < 20000) || /^outlook-[a-z0-9]+\.(png|jpe?g|gif)$/i.test(p.filename || ''));   // imza logoları, ikonlar
        var name = p.filename || ('gorsel-' + (out.length + 1) + '.' + (mime.split('/')[1] || 'png').replace('jpeg', 'jpg'));
        var key = name + '|' + size;
        if (!logo && !seen[key]) {
          seen[key] = true;
          out.push({ id: m.getId() + '|' + attId, name: name, mime: mime || 'application/octet-stream', size: size, image: isImg, inline: inline,
            msgNo: mi + 1, msgId: m.getId(), from: from.name || from.email || '', fromEmail: lc_(from.email || ''),
            role: roleOf_(lc_(from.email || ''), cfg), date: date ? date.toISOString() : '', snippet: getSnippet() });
        }
      }
      (p.parts || []).forEach(walk);
    })(m._m.payload);
  });
  out = out.slice(-40);
  // Aynı adlı dosyanın sonraki mesajda yeni sürümü varsa eskisi "older" işaretlenir
  out.forEach(function (a, i) { a.ref = 'E' + (i + 1); a.older = out.some(function (b, k) { return k > i && b.name === a.name; }); });
  // Güncel konu: aynı loop'ta aylar önceki konuların ekleri varsayılan olarak gösterilmez.
  //  - Son 3 mesaj (ve son mesajdan en fazla 10 gün önce) "güncel" sayılır; onların ekleri gösterilir.
  //  - Son mesajlar geçmişteki bir eke atıf yapıyorsa ("önceki maildeki", "daha önce ilettiğimiz", "yukarıdaki dosya"…) tüm ekler gösterilir.
  var n = msgs.length, lastAt = n ? msgs[n - 1].getDate().getTime() : 0, recentNos = {}, refPast = false;
  var PAST_RE = /(önceki|eski|ilk|geçen|yukarıdaki|aşağıdaki|daha önce|evvelce|bir önceki)\s*(mail|maildeki|e-?posta|ek|ekler|ekteki|dosya|görsel|sunum|tablo|paylaş|ilet|gönder)|daha önce (ilet|paylaş|gönder)|(previous|earlier|attached earlier|below thread)/i;
  for (var k = n - 1; k >= 0 && k >= n - 3; k--) {
    var mk = msgs[k];
    if (lastAt - mk.getDate().getTime() > 10 * 86400000) break;
    recentNos[k + 1] = true;
    try { if (PAST_RE.test(cleanBody_(mk.getPlainBody()))) refPast = true; } catch (e) {}
  }
  out.forEach(function (a) { a.recent = refPast || !!recentNos[a.msgNo]; });
  return out;
}
/** Board: görsel eklerin küçük önizlemesi (data URI). Sadece ≤ 1.5 MB görseller, en fazla 16 tane. */
function getAttachmentThumbs(list) {
  var out = {};
  (list || []).slice(0, 16).forEach(function (a) {
    if (!a || !/^image\//.test(a.mime || '') || Number(a.size) > 1500000) return;
    try {
      var ids = String(a.id).split('|');
      var data = gapi_(5, function () { return Gmail.Users.Messages.Attachments.get('me', ids[0], ids[1]).data; });
      out[a.id] = 'data:' + a.mime + ';base64,' + String(data).replace(/-/g, '+').replace(/_/g, '/');
    } catch (e) {}
  });
  return out;
}
/** AI'a ekleri anlatır: liste (ref, ad, boyut, kimden, hangi mesajla geldi) + seçili görsellerin kendisi (Gemini görseli görür) */
function attachmentsForAi_(atts) {
  if (!atts || !atts.length) return { text: '', parts: [] };
  var fmt = function (n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
  var lines = atts.map(function (a) {
    return a.ref + ' | ' + a.name + ' | ' + fmt(a.size) + ' | ' + (a.image ? (a.inline ? 'mail içine gömülü görsel' : 'görsel eki') : 'dosya eki') +
      ' | ' + (a.date ? Utilities.formatDate(new Date(a.date), 'Europe/Istanbul', 'dd.MM HH:mm') : '') + ' ' + a.from + (a.role ? ' [' + a.role + ']' : '') +
      (a.older ? ' | ESKİ SÜRÜM (aynı adla daha yeni bir sürüm var)' : '') + (a.recent === false ? ' | ESKİ KONU (son mesajlarla ilgisi yok, gerekmedikçe seçme)' : '') + (a.snippet ? ' | birlikte gelen mesaj: "' + a.snippet + '"' : '');
  });
  var parts = [], n = 0;
  atts.forEach(function (a) {
    // Gemini'nin desteklediği görsel türleri: png, jpeg, webp, heic, heif (gif ve "image/jpg" yazımı reddediliyor)
    var gm = String(a.mime || '').toLowerCase().replace('image/jpg', 'image/jpeg').replace('image/pjpeg', 'image/jpeg');
    if (n >= 6 || !a.image || a.older || a.recent === false || a.size > 1500000 || !/^image\/(png|jpeg|webp|heic|heif)$/.test(gm)) return;
    try {
      var ids = a.id.split('|');
      var data = gapi_(5, function () { return Gmail.Users.Messages.Attachments.get('me', ids[0], ids[1]).data; });
      parts.push({ text: 'Görsel ' + a.ref + ' (' + a.name + '):' });
      var b64 = typeof data === 'string' ? data.replace(/-/g, '+').replace(/_/g, '/') : Utilities.base64Encode(data);   // Gmail bazen bayt dizisi döndürüyor
      parts.push({ inline_data: { mime_type: gm, data: b64 } });
      n++;
    } catch (e) {}
  });
  return { text: 'MAİLDEKİ EKLER (ref | ad | boyut | tür | tarih ve gönderen | not):\n' + lines.join('\n') + (n ? '\nGörsellerin kendileri de ekte, içeriklerine bak.' : ''), parts: parts };
}
/** Seçilen mail eklerini Jira işine yükler (her biri en fazla 20 MB) */
/** Görselin gerçek piksel boyutu (PNG / JPEG / GIF / WebP başlığından). Bulunamazsa null. */
function imgDims_(bytes) {
  try {
    var b = function (i) { return bytes[i] & 255; }, n = bytes.length;
    if (n > 24 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return { w: (b(16) << 24 | b(17) << 16 | b(18) << 8 | b(19)) >>> 0, h: (b(20) << 24 | b(21) << 16 | b(22) << 8 | b(23)) >>> 0 };
    if (n > 10 && b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return { w: b(6) | b(7) << 8, h: b(8) | b(9) << 8 };
    if (n > 30 && b(0) === 0x52 && b(1) === 0x49 && b(8) === 0x57 && b(9) === 0x45) {   // WebP
      var f = String.fromCharCode(b(12), b(13), b(14), b(15));
      if (f === 'VP8X') return { w: 1 + (b(24) | b(25) << 8 | b(26) << 16), h: 1 + (b(27) | b(28) << 8 | b(29) << 16) };
      if (f === 'VP8 ') return { w: (b(26) | b(27) << 8) & 0x3fff, h: (b(28) | b(29) << 8) & 0x3fff };
      if (f === 'VP8L') { var v = b(21) | b(22) << 8 | b(23) << 16 | b(24) << 24; return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    }
    if (n > 4 && b(0) === 0xFF && b(1) === 0xD8) {   // JPEG: SOF işaretçisini ara
      var i = 2;
      while (i + 9 < n) {
        if (b(i) !== 0xFF) { i++; continue; }
        var mk = b(i + 1); if (mk === 0xD8 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { i += 2; continue; }
        var len = b(i + 2) << 8 | b(i + 3);
        if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) return { w: b(i + 7) << 8 | b(i + 8), h: b(i + 5) << 8 | b(i + 6) };
        i += 2 + len;
      }
    }
  } catch (e) {}
  return null;
}
/** Jira'nın wiki → ADF dönüşümü görsele boyut yazmazsa (varsayılan 200×183 kare kutu) yorum/açıklamadaki görsellere gerçek boyutu işle */
function jiraMediaDimsFix_(adf, dimsSeq) {
  var i = 0, changed = false;
  (function walk(nd) {
    if (!nd || typeof nd !== 'object') return;
    if (nd.type === 'media' && nd.attrs) { var d = dimsSeq[i++]; if (d && d.w && d.h && (nd.attrs.width !== d.w || nd.attrs.height !== d.h)) { nd.attrs.width = d.w; nd.attrs.height = d.h; changed = true; } }
    (nd.content || []).forEach(walk);
  })(adf);
  return changed;
}
/** Metindeki [[E#]] sırasıyla gömülen görsellerin boyutları */
function embedDimsSeq_(text, up) {
  return (String(text || '').match(/\[\[(E\d+)\]\]/gi) || []).map(function (t) { return t.replace(/[\[\]]/g, '').toUpperCase(); })
    .filter(function (r) { return up.names[r]; }).map(function (r) { return up.dims[r] || null; });
}
function uploadJiraAttachments_(key, list, embedRefs) {
  var res = { ok: 0, errors: [], names: {}, dims: {} };
  embedRefs = embedRefs || [];
  if (!list || !list.length) return res;
  var c = jiraCreds_(); if (!c) { res.errors.push('Jira bağlı değil'); return res; }
  list.forEach(function (a) {
    try {
      var parts = String(a.id || '').split('|'); if (parts.length < 2) throw new Error('geçersiz ek');
      if (Number(a.size) > 20 * 1024 * 1024) throw new Error('20 MB\'den büyük');
      var data = gapi_(5, function () { return Gmail.Users.Messages.Attachments.get('me', parts[0], parts[1]).data; });
      var bytes = typeof data === 'string' ? Utilities.base64DecodeWebSafe(data) : data;   // Gmail bazen bayt dizisi döndürüyor
      var ref = String(a.ref || '').toUpperCase(), fname = a.name || 'ek';
      // Gömülecek görsel: aynı adlı dosyalar (image.png) karışmasın diye benzersiz ad
      if (ref && embedRefs.indexOf(ref) >= 0) fname = ref + '_' + Utilities.formatDate(new Date(), 'Europe/Istanbul', 'HHmmss') + '_' + String(fname).replace(/[^\w.\-]+/g, '_').slice(-60);
      var blob = Utilities.newBlob(bytes, a.mime || 'application/octet-stream', fname);
      if (ref) { var dm = imgDims_(bytes); if (dm && dm.w && dm.h) res.dims[ref] = dm; }
      var r = UrlFetchApp.fetch(jiraSite_() + '/rest/api/3/issue/' + key + '/attachments', {
        method: 'post', muteHttpExceptions: true, payload: { file: blob },
        headers: { Authorization: 'Basic ' + Utilities.base64Encode(c.email + ':' + c.token), 'X-Atlassian-Token': 'no-check', Accept: 'application/json' }
      });
      if (r.getResponseCode() >= 300) throw new Error('Jira ' + r.getResponseCode());
      res.ok++;
      try { var up = JSON.parse(r.getContentText() || '[]'); if (ref && up[0] && up[0].filename) res.names[ref] = up[0].filename; } catch (e) { if (ref) res.names[ref] = fname; }
    } catch (e) { res.errors.push((a.name || 'ek') + ': ' + (e.message || e)); }
  });
  return res;
}
/** [[E2]] ile gömülen görsel, gönderilen ek listesinde yoksa thread'in eklerinden bulunup eklenir */
function jiraWithEmbeds_(list, embeds, threadId) {
  list = (list || []).slice();
  var have = list.map(function (a) { return String(a.ref || '').toUpperCase(); });
  var miss = embeds.filter(function (r) { return have.indexOf(r) < 0; });
  if (miss.length && threadId) {
    try { getThreadAttachments(threadId).forEach(function (a) { if (miss.indexOf(String(a.ref).toUpperCase()) >= 0) list.push(a); }); } catch (e) {}
  }
  return list;
}
/** Metindeki [[E2]] görsel işaretleri */
function embedRefsOf_(text) { var out = []; String(text || '').replace(/\[\[(E\d+)\]\]/gi, function (_, r) { r = r.toUpperCase(); if (out.indexOf(r) < 0) out.push(r); return _; }); return out; }
function stripEmbeds_(text) { return String(text || '').replace(/^[ \t]*\[\[E\d+\]\][ \t]*\n?/gim, '').replace(/\[\[E\d+\]\]/gi, '').replace(/\n{3,}/g, '\n\n'); }
/** Düz metin → Jira wiki markup. Kampanya adlarındaki _ * - gibi işaretler kaçışlanır (biçime dönüşmesin), linkler ve @etiketler korunur. */
/** Metinde Jira biçimlendirmesi (tablo / **kalın** / başlık / numaralı liste) var mı? Varsa yorum/açıklama wiki ile yazılır. */
function hasRich_(text) {
  var t = String(text || '');
  return /^\s*\|.*\|\s*$/m.test(t) || /\*\*[^*\n]+\*\*/.test(t) || /^\s*#{1,6}\s+\S/m.test(t) || /^\s*\d+[.)]\s+\S/m.test(t);
}
/** Düz metin + hafif markdown → Jira wiki markup. Kampanya adlarındaki _ * - gibi işaretler kaçışlanır; linkler, @etiketler, [[E#]] görseller,
 *  markdown tablolar (| a | b | + |---|), **kalın**, ### başlık, 1. numaralı liste, - madde (girintili → alt madde) desteklenir. */
function textToWiki_(text, mentions, names, dims) {
  mentions = mentions || {}; names = names || {}; dims = dims || {};
  var men = Object.keys(mentions).sort(function (a, b) { return b.length - a.length; });
  var esc = function (t) { return t.replace(/([*_^~+{}\[\]!|#\-])/g, '\\$1').replace(/\?\?/g, '\\?\\?'); };
  var img = function (ref) { var R = String(ref).toUpperCase(), n = names[R], d = dims[R]; return n ? '!' + n + (d ? '|width=' + d.w + ',height=' + d.h : '') + '!' : ''; };   // gerçek boyut (thumbnail/kare kutu değil)
  var tokRe = new RegExp('(https?:\\/\\/[^\\s<>|]+)|\\[\\[(E\\d+)\\]\\]|\\*\\*([^*\\n]+?)\\*\\*' + (men.length ? '|@(' + men.map(function (m) { return m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')' : ''), 'gi');
  var inl = function (body) {
    var out = '', last = 0, m, re = new RegExp(tokRe.source, 'gi');
    while ((m = re.exec(body))) {
      out += esc(body.slice(last, m.index));
      if (m[1]) out += m[1];
      else if (m[2]) out += ' ' + img(m[2]) + ' ';
      else if (m[3]) out += '*' + inl(m[3]).trim() + '*';
      else if (m[4]) { var k = men.filter(function (x) { return x.toLowerCase() === m[4].toLowerCase(); })[0]; out += '[~accountid:' + mentions[k] + ']'; }
      last = m.index + m[0].length;
    }
    return out + esc(body.slice(last));
  };
  var isRow = function (l) { return /^\s*\|.*\|\s*$/.test(l); };
  var isSep = function (l) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l); };
  var cells = function (l) { var c = l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|'); return c.map(function (x) { return x.trim(); }); };
  var lines = String(text || '').replace(/\r/g, '').split('\n'), out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (isRow(line) && !isSep(line)) {
      // Tablo bloğu: ilk satır başlık (ardından --- satırı gelsin gelmesin)
      var rows = [];
      while (i < lines.length && (isRow(lines[i]) || isSep(lines[i]))) { if (!isSep(lines[i])) rows.push(cells(lines[i])); i++; }
      i--;
      var ncol = Math.max.apply(null, rows.map(function (r) { return r.length; }));
      if (out.length && out[out.length - 1] !== '') out.push('');
      rows.forEach(function (r, ri) {
        while (r.length < ncol) r.push('');
        var cs = r.map(function (c) { var v = inl(c).trim(); return v || ' '; });
        out.push(ri === 0 ? '||' + cs.join('||') + '||' : '|' + cs.join('|') + '|');
      });
      if (i + 1 < lines.length && lines[i + 1].trim() !== '') out.push('');
      continue;
    }
    var lone = line.match(/^\s*\[\[(E\d+)\]\]\s*$/i);
    if (lone) { out.push(img(lone[1])); continue; }
    var hm = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (hm) { out.push('h4. ' + inl(hm[1].replace(/\*\*/g, ''))); continue; }
    var nm = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (nm) { out.push((nm[1].length >= 2 ? '## ' : '# ') + inl(nm[2])); continue; }
    var bm = line.match(/^(\s*)[-•–*]\s+(.*)$/);
    if (bm) { out.push((bm[1].length >= 2 ? '** ' : '* ') + inl(bm[2])); continue; }
    out.push(inl(line));
  }
  return out.join('\n');
}
/** Board: @etiket için Jira kullanıcı arama */
function jiraUserSearch(q) {
  q = String(q || '').trim(); if (q.length < 2) return [];
  var r = jiraFetch_('get', '/rest/api/3/user/search?maxResults=10&query=' + encodeURIComponent(q)) || [];
  return r.filter(function (u) { return u.accountType === 'atlassian' && u.active !== false; }).map(function (u) { return { id: u.accountId, n: u.displayName }; });
}
/** ADF → düz metin (açıklama ve yorumları okumak için) */
function adfToText_(n) {
  if (!n) return '';
  if (typeof n === 'string') return n;
  if (n.type === 'text') return n.text || '';
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'mention') return (n.attrs && n.attrs.text) || '@?';
  if (n.type === 'emoji') return (n.attrs && (n.attrs.text || n.attrs.shortName)) || '';
  if (n.type === 'inlineCard' || n.type === 'blockCard') return (n.attrs && n.attrs.url) || '';
  var inner = (n.content || []).map(adfToText_).join('');
  if (n.type === 'listItem') return '- ' + inner.trim() + '\n';
  if (n.type === 'tableRow') return '| ' + (n.content || []).map(function (c) { return adfToText_(c).replace(/\s+/g, ' ').trim(); }).join(' | ') + ' |\n';
  if (['paragraph', 'heading', 'codeBlock', 'blockquote', 'tableRow'].indexOf(n.type) >= 0) return inner.trim() + '\n';
  return inner;
}
/** Bir Jira işinin güncel hali: başlık, durum, atanan, açıklama, son yorumlar ve etiketlenebilecek kişiler */
function jiraIssueState_(key, nComments) {
  var m = String(key || '').toUpperCase().match(JIRA_KEY_RE_);
  if (!m) throw new Error('Geçerli bir iş anahtarı gir (ör. GRPADS-2219)');
  var i = jiraFetch_('get', '/rest/api/3/issue/' + m[1] + '?fields=summary,status,assignee,reporter,description,comment,labels,duedate,updated,project,attachment&expand=changelog');
  var f = i.fields || {}, people = {};
  var addP = function (u) { if (u && u.accountId && u.displayName && u.accountType !== 'app') people[u.displayName] = u.accountId; };
  addP(f.assignee); addP(f.reporter);
  var cs = ((f.comment && f.comment.comments) || []);
  cs.forEach(function (c) { addP(c.author); });
  var me = {}; try { me = JSON.parse(PropertiesService.getUserProperties().getProperty('JIRA_ACCOUNT') || '{}'); } catch (e) {}
  var comments = cs.slice(-(nComments || 10)).map(function (c) {
    var mine = !!(c.author && ((me.id && c.author.accountId === me.id) || (me.name && c.author.displayName === me.name)));
    return { author: (c.author && c.author.displayName) || '?', date: String(c.created || '').slice(0, 16).replace('T', ' '), ts: new Date(c.created).getTime() || 0,
      mine: mine, text: adfToText_(c.body).replace(/\n{3,}/g, '\n\n').trim() };
  });
  // Durum geçmişi: son 6 durum değişikliği (kim, ne zaman, nereden nereye) — "top kimde" bağlamı
  var statusHistory = [];
  try {
    ((i.changelog && i.changelog.histories) || []).forEach(function (h) {
      (h.items || []).forEach(function (it) { if (it.field === 'status') statusHistory.push({ date: String(h.created || '').slice(0, 16).replace('T', ' '), ts: new Date(h.created).getTime() || 0,
        author: (h.author && h.author.displayName) || '?', from: it.fromString || '', to: it.toString || '' }); });
    });
    statusHistory.sort(function (a, b) { return a.ts - b.ts; }); statusHistory = statusHistory.slice(-6);
  } catch (e) {}
  if (me.name) delete people[me.name];
  return {
    key: i.key, url: jiraSite_() + '/browse/' + i.key, summary: f.summary || '', status: (f.status && f.status.name) || '',
    assignee: (f.assignee && f.assignee.displayName) || '', reporter: (f.reporter && f.reporter.displayName) || '',
    project: (f.project && f.project.key) || '', labels: f.labels || [], due: f.duedate || '',
    description: adfToText_(f.description).replace(/\n{3,}/g, '\n\n').trim(), comments: comments, commentCount: cs.length, people: people, statusHistory: statusHistory,
    attachments: (f.attachment || []).map(function (x) { return x.filename; })
  };
}
/** Board: yorum hedefi seçilince kısa özet (AI yok) */
function getJiraIssueBrief(key) {
  var s = jiraIssueState_(key, 3);
  return { key: s.key, url: s.url, summary: s.summary, status: s.status, assignee: s.assignee, commentCount: s.commentCount,
    last: s.comments.length ? s.comments[s.comments.length - 1] : null, people: s.people };
}
/** Jira metinlerinde ekibe sadece talimat değil, markanın verdiği bağlam da aktarılır */
// Jira'da düzgün görünen biçim: metin wiki'ye çevrilir (textToWiki_) → tablo, kalın, başlık, liste Jira'nın kendi biçimine dönüşür
var JIRA_FORMAT_RULE_ = [
  'BİÇİMLENDİRME (metin Jira\'ya kendi biçimiyle aktarılır, gerektiğinde çekinmeden kullan):',
  '- TABLO: Mailde tablo varsa ("[Maildeki tablo]" bölümü) ya da birden çok öğenin (ülke, kampanya, feed, product set, template, bütçe, tarih…) aynı özellikleri sıralanıyorsa bunu TABLO olarak yaz. Format: ilk satır başlık "| Ülke | Feed | Product Set Name | Template Name | Günlük Bütçe |", ikinci satır "|---|---|---|---|---|", sonra her öğe tek satır. Maildeki tablonun sütunlarını koru, gerekirse mailde ayrı verilen bilgiyi (ör. bütçe) yeni sütun olarak ekle. Hücre değerlerini (feed/set/template/kampanya adları, rakamlar) birebir aktar.',
  '- Tablonun öncesine bağlamı anlatan kısa bir cümle yaz. Tablo verisini cümle içinde "|" ya da "Feed: … | Set: …" diye tek satıra SIKIŞTIRMA.',
  '- Madde için "- ", sıralı adımlar için "1. ", alt madde için iki boşluk + "- ". Gerçekten önemli bir ifadeyi **kalın** yapabilirsin (az kullan). Çok konulu uzun metinde konu ayırmak için "### Başlık" satırı kullanabilirsin; kısa yorumda başlık kullanma.',
].join('\n');
var JIRA_CONTEXT_RULE_ = [
  '- BAĞLAMI AKTAR, SADECE TALİMAT VERME: Ekip konuyu markanın gözünden anlamalı. Her iş için önce markanın tespitini/gözlemini ve gerekçesini ver, sonra isteneni yaz. Markanın verdiği somut detayları (ne kontrol etti, ne eksik/yanlış çıktı, rakamlar, oranlar, süreler: "son 2 gündür", "bütçesinin 3\'te 1\'i") kaybetmeden aktar.',
  '- Markanın açık bıraktığı alanı da ilet: "uygun olabilecek diğer listing grupları da eklenebilir", "sizin de öneriniz olursa değerlendirelim" gibi esneklikleri ve ekipten görüş/öneri beklendiğini yaz.',
  '- Birden fazla konu varsa her konuyu ayrı maddede, bağlamıyla birlikte yaz. Konuları birbirine karıştırma.',
  '- ÖRNEK. Marka maili: "Pmax kampanyalarının listing gruplarını kontrol ettik, bazı kampanyalarda listing gruplarımız eksik kalmış... TR_ABC_Perfmax_RE_Ayakkabi>Kadın Ayakkbı asset grubuna topuklu ayakkabı-kadın ve spor ayakkabı kadın listing gruplarını da ekleyelim. Uygun olabilecek diğer listing grupları da ekleyebilirsiniz." ve "TR_ABC_Perfmax_RE_Ic_Giyim kampanyası son 2 gündür bütçesinin 2 katından fazlasını harcamış..."',
  '  KÖTÜ: "- Kadın Ayakkbı asset grubuna topuklu ayakkabı-kadın listing grubunu ekleyelim." (neden eklendiği yok)',
  '  İYİ: "- Marka Pmax kampanyalarının listing gruplarını kontrol etmiş, bazı kampanyalarda listing grupları eksik kalmış. TR_ABC_Perfmax_RE_Ayakkabi kampanyasında Kadın Ayakkbı asset grubuna topuklu ayakkabı-kadın ve spor ayakkabı kadın, Erkek Ayakkabı asset grubuna spor ayakkabı erkek listing gruplarını ekleyelim. Uygun gördüğün başka listing grupları varsa onları da ekleyebiliriz, marka önerilerimize açık."',
  '  İYİ: "- Harcama tarafında dengesizlik var: TR_ABC_Perfmax_RE_Ic_Giyim son 2 gündür bütçesinin 2 katından fazlasını harcamış, TR_ABC_Perfmax_RE_Cocuk bütçesinin yarısından azını, TR_ABC_Perfmax_RE_Kadin_Giyim son 6 gündür bütçesinin 3\'te 1\'ini harcıyor. Harcama ve bid optimizasyonu için kontrol edebilir misin?"'
].join('\n');
function nowStr_() { return Utilities.formatDate(new Date(), 'Europe/Istanbul', 'dd.MM.yyyy HH:mm') + ' (' + ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'][Number(Utilities.formatDate(new Date(), 'Europe/Istanbul', 'u')) % 7] + ')'; }
function jiraCommentLines_(list, maxLen) {
  return list.map(function (c) { return '--- ' + c.date + ' | ' + c.author + (c.mine ? ' [SEN]' : '') + '\n' + c.text.slice(0, maxLen || 2500); }).join('\n');
}
/** Board: seçilen Jira işinin genel durumunu + mail thread'ini okuyup Deniz'ın ağzından yorum hazırla */
function generateJiraComment(threadId, key, hint) {
  var cfg = getConfig_(), me = cfg.MY_NAME || 'kullanıcı';
  var st = jiraIssueState_(key, 25);
  var th = apiThread_(String(threadId));
  var lastMineTs = 0; st.comments.forEach(function (c) { if (c.mine && c.ts > lastMineTs) lastMineTs = c.ts; });
  var afterMine = st.comments.filter(function (c) { return !c.mine && c.ts > lastMineTs; });
  var beforeC = st.comments.filter(function (c) { return afterMine.indexOf(c) < 0; }).slice(-10);
  var convo = [];
  if (th && th.exists()) {
    var facts = extractFacts_(th, cfg, null), used = 0;
    for (var i = facts.messages.length - 1; i >= 0; i--) {
      var m = facts.messages[i];
      var block = '### ' + Utilities.formatDate(m.date, 'Europe/Istanbul', 'dd.MM.yyyy HH:mm') + ' | ' + (m.from.name || '') + ' <' + m.from.email + '> [' + m.role + ']\n' + m.body + '\n';
      if (used + block.length > 20000 && convo.length) break;
      convo.unshift(block); used += block.length;
    }
  }
  var row = loadDb_().byId[String(threadId)] || {};
  var atts = []; try { atts = getThreadAttachments(threadId); } catch (e) {}
  var attAi = attachmentsForAi_(atts);
  var prompt = [
    'Sen ' + me + '\'sın. Jira\'daki ' + st.key + ' işine YORUM yazacaksın. Önce işin GENEL DURUMUNU incele: açıklamada ne istenmiş, yorumlarda ne yapılmış, en son kim ne demiş, şu an top kimde, ne eksik. Sonra mail thread\'inde bu işle ilgili YENİ olan ne var (markanın yeni talebi, değişiklik, onay, tarih, link) onu bul.',
    'Yorum, işi bir adım ileri taşımalı: ekibin bilmediği yeni bilgiyi ver, gerekiyorsa ne yapılmasını ya da kimden ne beklediğini net söyle. Task\'te zaten yazılı olanı tekrar etme. Mailde bu işle ilgili yeni bir şey yoksa bunu "reason" alanında söyle ve yine de işin durumuna uygun kısa bir takip yorumu öner.',
    'ŞU AN: ' + nowStr_(),
    'ZAMAN KURALI: Her yorumun ve mailin tarihine/saatine bak. Önceliğin, ' + me + '\'ın kendi son yorumundan SONRA gelen yorumlar ve mailler. Eski, zaten konuşulmuş ya da kapanmış konuları yeniden açma; en güncel durumu esas al.',
    row.brand ? 'Marka: ' + row.brand : '',
    hint ? 'NOT (' + me + ' özellikle istedi, yoruma yansıt): ' + String(hint).slice(0, 500) : '',
    '',
    'YORUM KURALLARI:',
    '- ' + me + '\'ın ağzından, ekibe yazıyormuş gibi. Samimi ve rahat ama cıvık değil; şaka, emoji, ünlem yok.',
    '- Biri bir şey yapacaksa yorumu "@Ad Soyad" ile başlat (sadece aşağıdaki KİŞİLER listesindeki isimleri birebir kullan). Herkese yönelikse etiket koyma.',
    '- Her cümle büyük harfle başlar, nokta ve virgül kullan, soru sorarken soru işareti kullan. Noktalı virgül, ünlem, üç nokta yok. İmza, "Sevgiler" yok. "Bitince buraya yaz, markaya bilgi geçerim" gibi kapanış/geri bildirim cümleleri ekleme.',
    '- KURULUM BİLGİLERİNE DOKUNMA: Markanın gönderdiği reklam/kurulum metinlerini ve etiketlerini (Primary text, Headline, Description, LP / landing page, URL, CTA, kampanya/kitle/set adları, UTM, görsel/video adları) mailde nasıl yazıyorsa öyle aktar. Etiketleri Türkçeye çevirme ("Başlık", "Açıklama", "Ana metin" deme), metinleri yeniden yazma, kısaltma, düzeltme. Sadece kendi giriş/açıklama cümlelerini toparla.',
    '- Uzunluk: Basit bir takip ise 1-3 cümle. Markadan yeni talep/bilgi aktarıyorsan ekibin konuyu anlaması için gereken bağlamı eksiksiz ver; kısa bir girişten sonra her konuyu "-" ile ayrı madde yaz. Linkleri, kampanya adlarını, rakamları ve tarihleri birebir koru. Bilmediğin bilgiyi uydurma, gerekiyorsa [köşeli parantez] bırak.',
    JIRA_CONTEXT_RULE_,
    JIRA_FORMAT_RULE_,
    '',
    'KİŞİLER: ' + (Object.keys(st.people).join(', ') || '—'),
    '',
    'JIRA İŞİ: ' + st.key + ' | ' + st.summary + ' | Durum: ' + st.status + ' | Atanan: ' + (st.assignee || 'yok') + ' | Açan: ' + st.reporter + (st.due ? ' | Bitiş: ' + st.due : ''),
    'AÇIKLAMA:', st.description.slice(0, 5000) || '—',
    st.statusHistory && st.statusHistory.length ? 'DURUM GEÇMİŞİ: ' + st.statusHistory.map(function (h) { return h.date + ' ' + h.author + ': ' + h.from + ' → ' + h.to; }).join(' | ') : '',
    'ÖNCEKİ YORUMLAR (bağlam, eskiden yeniye):',
    jiraCommentLines_(beforeC, 1500) || '—',
    'SENİN SON YORUMUNDAN SONRA GELEN YORUMLAR (ODAK — yorum bunlara cevap olmalı):',
    jiraCommentLines_(afterMine, 2500) || '— (senin son yorumundan sonra yeni yorum yok)',
    '',
    'MAIL THREAD (kronolojik):', convo.join('\n') || '—',
    '',
    attAi.text,
    atts.length ? 'TASK\'TE ZATEN OLAN EKLER: ' + (st.attachments.join(', ') || 'yok') : '',
    atts.length ? 'EKLER: Yorumla birlikte task\'e yüklenmesi GEREKEN ekleri içeriklerine bakarak seç ("attach": ["E2"]). Sadece işle ilgili YENİ ve gerekli dosyaları seç: task\'te zaten olanları, eski sürümleri, imza/logo ve bilgi amaçlı ekran görüntülerini seçme.' : '',
    atts.length ? 'GÖRSEL GÖMME: Ekibin bir görseli GÖRMESİ gerekiyorsa (reklam önizlemesi, kampanya/panel ekran görüntüsü, kreatif) yorumda ilgili cümlenin hemen altına tek başına bir satır olarak [[E2]] yaz (E2 yerine görselin ref\'i); görsel tam orada yorumun içinde gösterilir. Gömdüğün görselleri "attach" listesine de ekle. Gömülmeyen ekler için kısaca "Dosyalar ekte." de.' : '',
    'SADECE şu JSON\'u döndür: {"state": "işin şu anki durumu, 1-2 cümle (ne yapıldı, ne bekleniyor, top kimde)", "comment": "yorum metni", "reason": "mailde yeni bilgi yoksa kısa not, varsa boş", "attach": []}'
  ].filter(function (x) { return x !== ''; }).join('\n');
  var a = safeJson_(callGemini_(prompt, cfg, attAi.parts));
  var comment = String(a.comment || '').replace(/\r/g, '').trim();
  var refs = (a.attach || []).map(function (r) { return String(r).trim().toUpperCase(); });
  if (!comment) throw new Error('AI yorum üretemedi');
  return { key: st.key, url: st.url, state: String(a.state || '').trim(), comment: comment, reason: String(a.reason || '').trim(), people: st.people,
    attachments: atts, attach: atts.filter(function (t) { return refs.indexOf(t.ref) >= 0; }).map(function (t) { return t.id; }) };
}

/** Board (Jira kartı → Markaya dön): bu Jira işinin ilgili olduğu marka maili adayları */
function getBrandThreadCandidates(jiraThreadId) {
  var db = loadDb_(), id = String(jiraThreadId), jr = db.byId[id];
  if (!jr) throw new Error('Kart bulunamadı');
  var key = (String(jr.subject || '').match(JIRA_KEY_RE_) || [])[1] || '';
  var st = null; try { if (key) st = jiraIssueState_(key, 1); } catch (e) {}
  var summary = st ? st.summary : String(jr.title || jr.subject || '').replace(key, '');
  var proj = key.split('-')[0], mapped = key ? (jiraIssueThreads_()[key] || '') : '';
  var bnames = []; try { jiraMapRows_().forEach(function (r) { if (r.key === proj) bnames = bnames.concat(r.names); }); } catch (e) {}
  var jb = fold_(jr.brand || '').trim();
  var STOP = { 'icin': 1, 'ile': 1, 'olan': 1, 'reklam': 1, 'kampanya': 1, 'kampanyasi': 1, 'hakkinda': 1, 'guncelleme': 1, 'talep': 1, 'and': 1, 'the': 1, 'for': 1 };
  var toks = foldTr_(summary).split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 4 && !STOP[w]; });
  var lim = Date.now() - 60 * 86400000;
  var list = db.rows.filter(function (r) {
    if (String(r.threadId) === id) return false;
    var fl = String(r.flags || '');
    if (/(^|,)(JIRA|CALENDAR|CAL_RESPONSE|MEETING_NOTES)(,|$)/.test(fl) || ['IGNORED', 'AUTO'].indexOf(r.status) >= 0) return false;
    return String(r.threadId) === mapped || new Date(r.lastDate).getTime() >= lim;
  }).map(function (r) {
    var sc = 0, rb = fold_(r.brand || '').trim();
    if (String(r.threadId) === mapped) sc += 100;
    if (rb && ((jb && rb === jb) || bnames.indexOf(rb) >= 0 || bnames.some(function (n) { return n.length >= 3 && rb.indexOf(n) >= 0; }))) sc += 20;
    var hay = foldTr_((r.subject || '') + ' ' + (r.title || ''));
    toks.forEach(function (w) { if (hay.indexOf(w) >= 0) sc += 5; });
    if (isTrue_(r.closed)) sc -= 3;
    return { id: r.threadId, subject: r.subject, title: r.title, brand: r.brand, lastDate: r.lastDate, closed: isTrue_(r.closed), score: sc, mapped: String(r.threadId) === mapped };
  }).filter(function (x) { return x.score >= 5; });
  list.sort(function (a, b) { return b.score - a.score || new Date(b.lastDate) - new Date(a.lastDate); });
  list = list.slice(0, 8);
  return { key: key, summary: summary, status: st ? st.status : '', list: list, pick: list.length && list[0].score >= 20 ? list[0].id : '' };
}
/** Board (Markaya dön): Jira'daki son durumu okuyup seçilen marka mailine cevap taslağı hazırla. Mail GÖNDERİLMEZ; marka kartında normal onaylı gönderimle gider. */
/** Task'in hangi ekibe ait olduğu (etiket ya da başlıktan) */
function jiraTeamOf_(summary, labels) {
  var l = (labels || []).join(' '), s = String(summary || '');
  if (/Sosyal_Medya/i.test(l) || /\b(SM|Meta|TikTok|Sosyal)\b/i.test(s)) return 'SM';
  if (/Google_Ads/i.test(l) || /\b(Google|Pmax|YouTube|DV360)\b/i.test(s)) return 'Google';
  return '';
}
/**
 * Board (Jira kartı → Maile cevap): aynı marka cevabında birleştirilebilecek diğer ekip task'leri.
 *  auto=true: bu marka mailine zaten bağlı task'ler (task bu mailden açıldı / buradan yorum yazıldı / buraya cevap verildi)
 *  öneri: aynı projede, başlığı benzer (ekip adı hariç) ve son 45 günde güncellenmiş task'ler; karşı ekipse öne çıkar
 */
function getSiblingTasks(jiraThreadId, brandThreadId) {
  var db = loadDb_(), jr = db.byId[String(jiraThreadId)];
  var key = (String(jr && jr.subject || '').match(JIRA_KEY_RE_) || [])[1] || '';
  var out = [], seen = {}; seen[key] = 1;
  var map = jiraIssueThreads_();
  Object.keys(map).forEach(function (k) { if (String(map[k]) === String(brandThreadId) && !seen[k]) { seen[k] = 1; out.push({ key: k, s: '', team: '', why: 'aynı marka mailine bağlı', auto: true, sc: 100 }); } });
  if (key && jiraCreds_()) {
    var me = null; try { me = jiraFetch_('get', '/rest/api/3/issue/' + key + '?fields=summary,labels,project', null, true); } catch (e) {}
    var f = (me && !me._err && me.fields) || {}, myTeam = jiraTeamOf_(f.summary, f.labels), proj = key.split('-')[0];
    var norm = function (t) { return foldTr_(String(t || '')).replace(/\b(sm|google|meta|tiktok|sosyal medya|ads|orn|ornek moda)\b/g, ' ').split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 3 && !/^(ekim|kasim|aralik|ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|2026|2027|kampanya|kampanyasi|kampanyalari)$/.test(w); }); };
    var mine = norm(f.summary);
    var list = []; try { list = jiraSearch_('project = ' + proj + ' AND updated >= -45d AND key != ' + key + ' ORDER BY updated DESC', ['summary', 'labels'], 40); } catch (e) {}
    list.forEach(function (i, idx) {
      var fs = i.fields || {}, t = jiraTeamOf_(fs.summary, fs.labels), words = norm(fs.summary);
      var common = mine.filter(function (w) { return words.indexOf(w) >= 0; });
      var sc = common.length * 10 + (myTeam && t && t !== myTeam ? 8 : 0) - idx * 0.1;
      if (seen[i.key]) { out.forEach(function (o) { if (o.key === i.key) { o.s = fs.summary || ''; o.team = t; } }); return; }
      if (common.length) out.push({ key: i.key, s: fs.summary || '', team: t, why: 'benzer başlık: ' + common.slice(0, 3).join(', '), sc: sc });
    });
  }
  out.sort(function (a, b) { return b.sc - a.sc; });
  return { key: key, list: out.slice(0, 6) };
}
/** Bir task'in marka cevabı için bağlamı: çapa tarihinden SONRA olanlar odak, öncesi kısa bağlam */
function brandTaskInfo_(key, anchorTs, fmt) {
  var st = jiraIssueState_(key, 30), team = jiraTeamOf_(st.summary, st.labels);
  var newC = st.comments.filter(function (c) { return c.ts > anchorTs; });
  var oldC = st.comments.filter(function (c) { return c.ts <= anchorTs; }).slice(-3);
  var newS = (st.statusHistory || []).filter(function (h) { return h.ts > anchorTs; });
  return [
    '##### ' + (team ? team + ' EKİBİ — ' : '') + 'Jira işi ' + st.key + ': ' + st.summary + ' | Şu anki durum: ' + st.status + (st.due ? ' | Bitiş: ' + st.due : ''),
    '=== ' + (anchorTs ? fmt(anchorTs) + ' SONRASINDA' : 'SON') + ' BU TASK\'TE OLANLAR (cevabın konusu, en sondaki en güncel) ===',
    newS.length ? 'Durum değişiklikleri: ' + newS.map(function (h) { return h.date + ' ' + h.from + ' → ' + h.to; }).join(' | ') : '',
    jiraCommentLines_(newC, 2500) || '— Bu tarihten sonra bu task\'te yeni yorum yok.',
    '=== DAHA ESKİ YORUMLAR (sadece bağlam; cevaba KOYMA) ===',
    jiraCommentLines_(oldC, 400) || '—'
  ].filter(function (x) { return x !== ''; }).join('\n');
}
/** Board (mail kartı → Cevap): bu mailin ilgili Jira task'leri (ekip başına öneri + son task'ler) */
function getReplyJiraTasks(threadId) {
  var x = getJiraContext(threadId);
  if (!x || !x.connected) return { connected: false };
  return { connected: true, suggest: x.suggest || {}, targets: (x.targets || []).slice(0, 40) };
}
/** Board (mail kartı → Cevap): seçilen Jira task'lerinin bu thread'deki son mesajımdan SONRAKİ gelişmelerini okuyup markaya cevap yaz */
function prepareReplyFromJira(threadId, hint, keys) {
  keys = (keys || []).map(function (k) { return String(k || '').toUpperCase().trim(); }).filter(function (k) { return JIRA_KEY_RE_.test(k); });
  if (!keys.length) return { reply: generateAiReply(threadId, hint, null), keys: [], failed: [] };
  return prepareBrandUpdate(null, threadId, hint, keys);
}
function prepareBrandUpdate(jiraThreadId, brandThreadId, hint, extraKeys) {
  var cfg = getConfig_();
  var db = loadDb_(), jr = db.byId[String(jiraThreadId)], br = db.byId[String(brandThreadId)];
  if (!br) throw new Error('Marka maili bulunamadı');
  var key = (String(jr && jr.subject || '').match(JIRA_KEY_RE_) || [])[1] || '';
  var keys = [key].concat((extraKeys || []).map(function (k) { return String(k || '').toUpperCase().trim(); })).filter(function (k, i, a) { return k && JIRA_KEY_RE_.test(k) && a.indexOf(k) === i; });
  // Marka thread'inde benim son mesajım (yoksa markanın son mesajı) = çapa. Jira'da bu andan SONRA olanlar cevabın konusu.
  var anchorTs = 0, anchorTxt = '', anchorWho = '';
  try {
    var bf = extractFacts_(apiThread_(String(brandThreadId)), cfg, null);
    for (var i = bf.messages.length - 1; i >= 0; i--) { var m = bf.messages[i]; if (m.role === 'ME') { anchorTs = m.date.getTime(); anchorTxt = m.body; anchorWho = 'sen'; break; } }
    if (!anchorTs && bf.messages.length) { var lm = bf.messages[bf.messages.length - 1]; anchorTs = lm.date.getTime(); anchorTxt = lm.body; anchorWho = lm.from.name || lm.from.email; }
  } catch (e) {}
  var fmt = function (ts) { return Utilities.formatDate(new Date(ts), 'Europe/Istanbul', 'dd.MM.yyyy HH:mm'); };
  var parts = [], failed = [];
  keys.forEach(function (k) { try { parts.push(brandTaskInfo_(k, anchorTs, fmt)); } catch (e) { failed.push(k); } });
  if (!parts.length) {
    try { var ms = apiThread_(String(jiraThreadId)).getMessages(); parts.push('Son Jira bildirimi (' + fmt(ms[ms.length - 1].getDate().getTime()) + '):\n' + String(ms[ms.length - 1].getPlainBody() || '').slice(0, 3000)); } catch (e2) {}
  }
  if (!parts.length) throw new Error('Jira güncellemesi okunamadı');
  var info = [
    anchorTs ? 'Markaya bu thread\'de en son ' + fmt(anchorTs) + ' tarihinde ' + (anchorWho === 'sen' ? 'SEN yazdın' : anchorWho + ' yazdı') + ': "' + String(anchorTxt).replace(/\s+/g, ' ').slice(0, 400) + '"' : '',
    ''
  ].concat(parts.map(function (x) { return x + '\n'; })).filter(String).join('\n');
  var multi = parts.length > 1;
  var hint2 = [
    'Bu mail, markaya iç ekiplerin Jira\'daki EN GÜNCEL ilerlemesini bildirmek için. Sadece "SONRASINDA ... OLANLAR" bölümlerindeki gelişmeleri aktar: ekip ne yaptı (ör. LP güncellendi, ad set eklendi), neyi neden yapmadı (ör. o kampanyada LP alanı yok), markadan bir şey gerekiyorsa onu sor.',
    multi ? 'BİRDEN FAZLA EKİP TASK\'İ VAR (ör. SM ve Google): hepsinin gelişmelerini TEK bir mailde birleştir. Platform/kanal bazında (Meta tarafında…, Google tarafında…) ya da konu bazında düzenli aktar; aynı bilgiyi iki kez yazma. Bir task\'te yeni gelişme yoksa o kanal için uydurma; gerekiyorsa "devam ediyor" de ya da hiç bahsetme.' : '',
    'Markanın bu thread\'deki talebini ve senin verdiğin sözü ("güncelliyoruz" vb.) dikkate al: cevap o talebin/sözün sonucunu bildirsin. Eski yorumlardaki konuları markaya anlatma.',
    'Jira\'yı, task numaralarını, iç ekip isimlerini ve iç tartışmayı markaya anlatma. Kampanya adlarını, linkleri ve tarihleri birebir koru. Kısa ve net tut.',
    hint ? 'Ayrıca şunu söyle: ' + String(hint).slice(0, 500) : '',
    '', info.slice(0, multi ? 9000 : 6000)
  ].filter(String).join('\n');
  var reply = generateAiReply(brandThreadId, hint2, null);
  keys.forEach(function (k) { if (failed.indexOf(k) < 0) jiraIssueThreadSet_(k, brandThreadId); });
  return { reply: reply, key: key, keys: keys, failed: failed, card: toCard_(loadDb_().byId[String(brandThreadId)]) };
}

/** Board (Jira kartı → 📨 Yeni mail): alıcı önerisi (ilgili marka mailinden) + birleştirilebilecek diğer ekip task'leri */
function getNewMailContext(jiraThreadId) {
  var cfg = getConfig_(), out = { to: [], cc: [], options: [], from: '', siblings: [] };
  var cand = null; try { cand = getBrandThreadCandidates(jiraThreadId); } catch (e) {}
  var pick = cand && (cand.pick || (cand.list[0] && cand.list[0].id));
  if (pick) {
    try {
      var rc = getReplyRecipients(pick), row = loadDb_().byId[String(pick)] || {};
      out.options = rc.options || [];
      var ext = out.options.filter(function (o) { return o.role === 'EXTERNAL'; }).map(function (o) { return o.email; });
      var cmE = out.options.filter(function (o) { return o.role === 'CM'; }).map(function (o) { return o.email; });
      out.to = ext.length ? ext.slice(0, 4) : (rc.to || []);
      out.cc = cmE.filter(function (e) { return out.to.indexOf(e) < 0; });
      out.from = row.title || row.subject || '';
    } catch (e) {}
  }
  try { out.siblings = getSiblingTasks(jiraThreadId, pick || '').list || []; } catch (e) {}
  return out;
}
/** Board (📨 Yeni mail): Jira task(lar)ından markaya YENİ bir mail (konu + metin) yazar. Gönderilmez. */
function prepareNewMail(jiraThreadId, hint, extraKeys, to, cc) {
  var cfg = getConfig_(), db = loadDb_(), jr = db.byId[String(jiraThreadId)] || {};
  var key = (String(jr.subject || '').match(JIRA_KEY_RE_) || [])[1] || '';
  var keys = [key].concat((extraKeys || []).map(function (k) { return String(k || '').toUpperCase().trim(); })).filter(function (k, i, a) { return k && JIRA_KEY_RE_.test(k) && a.indexOf(k) === i; });
  var parts = [];
  keys.forEach(function (k) {
    try {
      var st = jiraIssueState_(k, 8), team = jiraTeamOf_(st.summary, st.labels);
      parts.push(['##### ' + (team ? team + ' EKİBİ — ' : '') + 'Jira işi ' + st.key + ': ' + st.summary + ' | Durum: ' + st.status + (st.due ? ' | Bitiş: ' + st.due : ''),
        'Açıklama (kısaltılmış):', (st.description || '—').slice(0, 1500),
        'Son yorumlar (eskiden yeniye, en sondaki en güncel):', jiraCommentLines_(st.comments, 1500) || '—'].join('\n'));
    } catch (e) {}
  });
  if (!parts.length) throw new Error('Jira task\'leri okunamadı (Jira bağlı mı?)');
  var rcp = [].concat(to || [], cc || []).map(function (e) { return e + ' [' + roleOf_(lc_(e), cfg) + ']'; }).join(', ');
  var prompt = [
    'Sen ' + (cfg.MY_NAME || 'kullanıcı') + '\'sın. Markaya YENİ bir mail (yeni konu, cevap değil) yazacaksın. Kaynak, ajans içi ekiplerin aşağıdaki Jira task(lar)ı.',
    'ŞU AN: ' + nowStr_(),
    'ALICILAR: ' + (rcp || '—'),
    hint ? 'KULLANICININ NOTU (mail bunu söylemeli): ' + String(hint).slice(0, 800) : '',
    'KURALLAR:',
    '- Markayı ilgilendiren en güncel gelişmeyi ya da markadan istenen şeyi net aktar (yorumların tarihine bak, en günceli esas al). Eski, kapanmış konuları anlatma.',
    '- Jira\'dan, task numaralarından, iç ekip isimlerinden ve iç tartışmadan bahsetme. Kampanya adlarını, linkleri ve tarihleri birebir koru.',
    keys.length > 1 ? '- Birden fazla ekip task\'i var: hepsini tek mailde, kanal ya da konu bazında düzenli birleştir; aynı bilgiyi iki kez yazma, yeni gelişmesi olmayan için bilgi uydurma.' : '',
    '- Konu satırı yazı avatarındaki "Konu satırı (yeni thread)" kuralına uysun (ör. "<Marka> x BIZ - <Konu>"); iç Jira başlık formatını kullanma.',
    '- Bilmediğin bilgi için [köşeli parantez] bırak.',
    '',
    '--- YAZI AVATARI ---', (typeof WRITING_STYLE_ === 'string' ? WRITING_STYLE_ : ''), '--- YAZI AVATARI SONU ---',
    '',
    parts.join('\n\n'),
    '',
    'SADECE şu JSON\'u döndür: {"subject": "konu satırı", "body": "gönderilmeye hazır mail gövdesi (imzasız)"}'
  ].filter(String).join('\n');
  var a = safeJson_(callGemini_(prompt, cfg));
  var body = cleanReply_({ reply: a.body || '' });
  if (!body) throw new Error('AI boş mail döndürdü');
  return { subject: String(a.subject || '').replace(/\s+/g, ' ').trim(), body: body, keys: keys };
}
function buildNewMimeHtml_(from, toList, ccList, subject, text, html) {
  var enc = function (x) { return '=?UTF-8?B?' + Utilities.base64Encode(Utilities.newBlob(x).getBytes()) + '?='; };
  var b = 'mb_' + Utilities.getUuid().replace(/-/g, '');
  var lines = ['From: ' + from, 'To: ' + toList.join(', ')];
  if (ccList.length) lines.push('Cc: ' + ccList.join(', '));
  lines.push('Subject: ' + enc(subject), 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="' + b + '"');
  var part = function (type, body) { return '--' + b + '\r\nContent-Type: ' + type + '; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Utilities.base64Encode(Utilities.newBlob(body).getBytes()) + '\r\n'; };
  var mime = lines.join('\r\n') + '\r\n\r\n' + part('text/plain', text) + part('text/html', html) + '--' + b + '--';
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(mime).getBytes());
}
/** Board (📨 Yeni mail): yeni konu olarak gönder (mode='send') ya da Gmail'de taslak oluştur (mode='draft'). Gönderilen thread Jira task(lar)ına bağlanır. */
function sendNewMail(jiraThreadId, to, cc, subject, body, extraKeys, mode) {
  var cfg = getConfig_();
  var ok = function (e) { return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(e); };
  to = (to || []).map(function (e) { return lc_(String(e).trim()); }).filter(ok);
  cc = (cc || []).map(function (e) { return lc_(String(e).trim()); }).filter(function (e) { return ok(e) && to.indexOf(e) < 0; });
  if (!to.length) throw new Error('En az bir "Kime" alıcısı seç');
  subject = String(subject || '').replace(/\s+/g, ' ').trim(); if (!subject) throw new Error('Konu boş');
  var text = String(body || '').replace(/\s+$/, ''); if (!text) throw new Error('Mesaj boş');
  var sig = getSignature_(cfg);
  var html = '<div dir="ltr">' + escHtml_(text).replace(/\n/g, '<br>') + '</div>' +
             (sig.html ? '<div class="gmail_signature" data-smartmail="gmail_signature">' + tightSig_(sig.html) + '</div>' : '');
  var raw = buildNewMimeHtml_(mailbox_(cfg.MY_NAME, cfg.myEmail), to, cc, subject, text + (sig.text ? '\n' + sig.text : ''), html);
  if (mode !== 'send') { Gmail.Users.Drafts.create({ message: { raw: raw } }, 'me'); return { mode: 'draft' }; }
  var r = Gmail.Users.Messages.send({ raw: raw }, 'me');
  var jr = loadDb_().byId[String(jiraThreadId)] || {};
  var key = (String(jr.subject || '').match(JIRA_KEY_RE_) || [])[1] || '';
  [key].concat(extraKeys || []).forEach(function (k) { k = String(k || '').toUpperCase(); if (k && JIRA_KEY_RE_.test(k) && r.threadId) jiraIssueThreadSet_(k, r.threadId); });
  log_('INFO', 'Yeni mail gönderildi (Jira ' + key + '): "' + subject + '" → ' + to.concat(cc).join(', ') + ' [' + r.threadId + ']');
  return { mode: 'send', threadId: r.threadId, link: gmailLink_(r.threadId, cfg) };
}

function cleanReply_(a) {
  var t = String(a && (a.reply || a.suggested_reply) || '').replace(/\r/g, '').trim();
  return t.replace(/^(işte|here is)[^\n]*:\s*\n+/i, '').trim();
}
/** Board: "AI ile cevap yaz" — her kart için (hint: isteğe bağlı kısa not) */
function generateAiReply(threadId, hint, rcpt) {
  var cfg = getConfig_();
  var th = apiThread_(String(threadId));
  if (!th || !th.exists()) throw new Error('Thread bulunamadı');
  var db0 = loadDb_(), row0 = db0.byId[String(threadId)];
  var facts = extractFacts_(th, cfg, null);                       // thread'in tamamı
  if (rcpt && (rcpt.to || rcpt.cc)) facts.rcptOverride = [].concat(rcpt.to || [], rcpt.cc || []).map(lc_);
  var reply = cleanReply_(safeJson_(callGemini_(buildReplyPrompt_(facts, cfg, row0 && row0.memory, hint), cfg)));
  if (!reply) throw new Error('AI boş cevap döndürdü');
  var lock = LockService.getUserLock(); lock.waitLock(15000);
  try {
    var db = loadDb_(), row = db.byId[String(threadId)];
    if (row) { row.suggestedReply = reply; row.updatedAt = new Date().toISOString(); saveRow_(db, row); flushDb_(db); }
  } finally { lock.releaseLock(); }
  return reply;
}

// ============================================================
//  DİJİTAL İKİZ (YAZI AVATARI) — isteğe bağlı
//  Kullanıcının gönderdiği maillerden (gelen → kullanıcının cevabı çiftleri) üslup kılavuzu + gerçek örnekler çıkarır.
//  "Yazı Avatarı" sayfasına yazılır; kullanıcı orada düzenleyebilir. Boşsa cevaplar genel kurallarla yazılır.
// ============================================================
var SHEET_AVATAR = 'Yazı Avatarı';
var AVATAR_CHUNK = 40000;
function writingStyle_() {
  if (typeof WRITING_STYLE_ === 'string' && WRITING_STYLE_) return WRITING_STYLE_;      // elle konmuş Style.gs öncelikli
  if (writingStyle_._c !== undefined) return writingStyle_._c;
  var txt = '';
  try {
    var sh = ss_().getSheetByName(SHEET_AVATAR);
    if (sh && sh.getLastRow() >= 3) txt = sh.getRange(3, 1, sh.getLastRow() - 2, 1).getValues().map(function (r) { return String(r[0] || ''); }).join('');
  } catch (e) {}
  writingStyle_._c = txt.trim();
  return writingStyle_._c;
}
/** Gönderilmiş maillerden gelen→cevap çiftleri (en fazla ~200, süre sınırlı) */
function collectReplyPairs_(cfg, maxPairs, started) {
  var pairs = [], start = 0;
  while (pairs.length < maxPairs && start < 600 && Date.now() - started < 200000) {
    var threads = GmailApp.search('in:sent newer_than:365d -in:chats', start, 50);
    if (!threads.length) break;
    start += threads.length;
    threads.forEach(function (th) {
      if (pairs.length >= maxPairs || Date.now() - started > 200000) return;
      var ms = th.getMessages().filter(function (m) { return !m.isDraft(); });
      for (var i = ms.length - 1; i > 0; i--) {
        var me = lc_((parseAddresses_(ms[i].getFrom())[0] || {}).email || '');
        if (me !== cfg.myEmail) continue;
        var prev = ms[i - 1], pf = (parseAddresses_(prev.getFrom())[0] || {});
        if (lc_(pf.email || '') === cfg.myEmail) continue;
        var reply = cleanBody_(ms[i].getPlainBody() || '').trim(), inc = cleanBody_(prev.getPlainBody() || '').trim();
        if (reply.length < 4 || /^-+\s*forwarded/i.test(reply)) continue;
        var rec = parseAddresses_(ms[i].getTo()).concat(parseAddresses_(ms[i].getCc() || ''));
        var roles = rec.map(function (a) { return roleOf_(a.email, cfg); }).filter(function (r) { return r !== 'ME'; });
        var aud = roles.indexOf('EXTERNAL') >= 0 ? 'dış taraf/marka' : (roles.length && roles.every(function (r) { return r === 'CM'; }) ? 'ekip üyeleri (takip edilen ekip)' : 'iç ekip');
        pairs.push({ konu: th.getFirstMessageSubject(), alici: aud, gelen: inc.slice(0, 1200), cevap: reply.slice(0, 1500) });
        break;                                                            // thread başına 1 çift (çeşitlilik)
      }
    });
  }
  return pairs;
}
/** Menü: Dijital ikizi oluştur / güncelle */
function buildDigitalTwin() {
  var ui = null; try { ui = SpreadsheetApp.getUi(); } catch (e) {}
  var cfg = getConfig_(), started = Date.now();
  var pairs = collectReplyPairs_(cfg, 200, started);
  if (pairs.length < 15) { var m0 = 'Yeterli gönderilmiş mail bulunamadı (' + pairs.length + ' cevap). En az ~15 cevap gerekiyor.'; if (ui) ui.alert(m0); return m0; }
  var prompt = [
    'Aşağıda ' + (cfg.MY_NAME || 'kullanıcı') + '\'nın iş maillerinden gerçek "gelen mail → onun cevabı" çiftleri var (' + pairs.length + ' adet).',
    'Görevin: Bu kişinin DİJİTAL İKİZİ için bir yazı avatarı çıkarmak. Bir yapay zekâ bu kılavuzla onun adına mail cevabı yazacak.',
    'Kılavuz (Türkçe, maddeli, en fazla ~7000 karakter) şunları içersin:',
    '1. Alıcıya göre hitap ve kapanış (dış taraf/marka, iç ekip, takip edilen ekip üyeleri ayrı ayrı; ilk satırın birebir hali, kapanış, imza yazıp yazmadığı).',
    '2. Ton, uzunluk (tipik cevap kaç cümle), cümle yapısı, "biz/ben" kullanımı, fiil kipleri (yapıyoruz / yaptık / yapacağız).',
    '3. Sık kullandığı kalıplar, bağlaçlar, terimler; biçim (bullet, bold, link verme şekli, emoji/ünlem kullanımı).',
    '4. Durum → tepki: onay/durum, iletme, takip ("ne durumda?"), şikâyet/hata, bütçe, toplantı, öneri gibi tiplerde nasıl cevap verdiği.',
    '5. YAPMA listesi: asla kullanmadığı kalıplar, AI gibi duran ifadeler.',
    'Gözlemle; uydurma. Kişisel/gizli bilgileri (rakam, link, kişi adı) kılavuza KOPYALAMA.',
    'Ayrıca farklı alıcı ve durumları kapsayan 12 kısa örnek seç (cevap en fazla ~400 karakter, gelen en fazla ~400 karakter; kısalt).',
    'SADECE şu JSON\'u döndür: {"kilavuz": "...", "ornekler": [{"alici": "...", "durum": "...", "gelen": "...", "cevap": "..."}]}',
    '',
    'ÇİFTLER:',
    JSON.stringify(pairs)
  ].join('\n');
  var a = safeJson_(callGemini_(prompt, cfg));
  if (!a || !a.kilavuz) { var m1 = 'Dijital ikiz oluşturulamadı (AI yanıtı çözümlenemedi). Tekrar dene.'; if (ui) ui.alert(m1); return m1; }
  var txt = String(a.kilavuz).trim() + '\n\n## Gerçek örnekler (refleksi ve ölçüyü öğren, cümleleri kopyalama)\n' +
    (a.ornekler || []).map(function (x) { return '\n[' + (x.alici || '') + ' · ' + (x.durum || '') + ']\nGELEN:\n' + (x.gelen || '') + '\nCEVAP:\n' + (x.cevap || ''); }).join('\n');
  var sh = ss_().getSheetByName(SHEET_AVATAR) || ss_().insertSheet(SHEET_AVATAR);
  sh.clear();
  sh.getRange(1, 1).setValue('Yazı avatarı (dijital ikiz) — ' + pairs.length + ' gönderilmiş cevaptan ' + Utilities.formatDate(new Date(), 'Europe/Istanbul', 'dd.MM.yyyy') + ' tarihinde oluşturuldu.').setFontWeight('bold');
  sh.getRange(2, 1).setValue('Aşağıdaki metni düzenleyebilirsin (A3 ve altı birleştirilerek kullanılır). Silersen cevaplar genel kurallarla yazılır. Menüden tekrar oluşturabilirsin.');
  var chunks = []; for (var i = 0; i < txt.length; i += AVATAR_CHUNK) chunks.push([txt.slice(i, i + AVATAR_CHUNK)]);
  sh.getRange(3, 1, chunks.length, 1).setValues(chunks).setWrap(true).setVerticalAlignment('top');
  sh.setColumnWidth(1, 900);
  log_('INFO', 'Dijital ikiz oluşturuldu: ' + pairs.length + ' cevaptan, ' + txt.length + ' karakter.');
  var msg = 'Dijital ikiz hazır (' + pairs.length + ' cevaptan). "' + SHEET_AVATAR + '" sayfasında görüp düzenleyebilirsin. Cevap taslakları artık bu üslupla yazılacak.';
  if (ui) ui.alert(msg);
  return msg;
}

function fmtAddr_(a) { return (a.name ? a.name + ' ' : '') + '<' + a.email + '>'; }

function callGemini_(prompt, cfg, extraParts) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY tanımlı değil (menü > Gemini API key gir).');
  var models = geminiModels_(cfg, key);
  var payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }].concat(extraParts || []) }],
    generationConfig: { responseMimeType: 'application/json' }
  };
  var lastErr = '';
  for (var mi = 0; mi < models.length; mi++) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + models[mi] + ':generateContent', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': key },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code === 200) {
        var j = JSON.parse(res.getContentText());
        var parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
        return parts.map(function (p) { return p.text || ''; }).join('');
      }
      lastErr = models[mi] + ' → HTTP ' + code + ': ' + res.getContentText().slice(0, 300);
      if (code === 404 || code === 400 && /not found|not supported/i.test(res.getContentText())) { markBadModel_(models[mi]); break; }   // model kalkmış → sıradaki
      // Görsel/ek kaynaklı 400 (desteklenmeyen tür, bozuk görsel, boyut) → görseller olmadan tekrar dene
      if (code === 400 && extraParts && extraParts.length) {
        try { log_('WARN', 'Gemini görselleri kabul etmedi, görselsiz tekrar deneniyor: ' + lastErr); } catch (e) {}
        extraParts = null; payload.contents[0].parts = [{ text: prompt }]; attempt--; continue;
      }
      if (code === 429) { if (attempt >= 1) break; Utilities.sleep(2000); continue; }   // ücretsiz kota modele özel → hızla diğer modele geç
      if (code >= 500) { Utilities.sleep(1500 * (attempt + 1)); continue; }
      break;
    }
  }
  try { log_('ERROR', 'Gemini hatası: ' + lastErr); } catch (e) {}
  throw new Error('Gemini hatası: ' + lastErr);
}

/** Denenecek modeller: ayarlardakiler → hesabında açık diğer Flash modelleri (günlük önbellek). Kalkmış modeller atlanır. */
function geminiModels_(cfg, key) {
  var sp = PropertiesService.getScriptProperties();
  var bad = {}; try { bad = JSON.parse(sp.getProperty('AI_BAD_MODELS') || '{}'); } catch (e) {}
  var list = [cfg.GEMINI_MODEL].concat(String(cfg.FALLBACK_MODEL || '').split(',')).map(function (x) { return String(x || '').trim(); }).filter(String);
  var disc = [];
  try {
    var c = JSON.parse(sp.getProperty('AI_MODEL_LIST') || 'null');
    if (!c || Date.now() - c.at > 86400000) {
      var r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
      var names = [];
      if (r.getResponseCode() === 200) (JSON.parse(r.getContentText()).models || []).forEach(function (m) {
        var n = String(m.name || '').replace(/^models\//, '');
        if ((m.supportedGenerationMethods || []).indexOf('generateContent') >= 0 && /flash/i.test(n) && !/(image|tts|audio|live|embedding|thinking-exp)/i.test(n)) names.push(n);
      });
      // yeni sürüm önce; "-lite" en sona (ucuz ama zayıf), preview/exp sona
      names.sort(function (a, b) { var s = function (x) { return (/lite/.test(x) ? 2 : 0) + (/(preview|exp)/.test(x) ? 1 : 0); }; return s(a) - s(b) || (b > a ? 1 : -1); });
      c = { at: Date.now(), names: names.slice(0, 6) };
      sp.setProperty('AI_MODEL_LIST', JSON.stringify(c));
    }
    disc = c.names || [];
  } catch (e) {}
  return uniq_(list.concat(disc)).filter(function (m) { return !bad[m] || Date.now() - bad[m] > 7 * 86400000; });
}
function markBadModel_(m) {
  var sp = PropertiesService.getScriptProperties(), bad = {};
  try { bad = JSON.parse(sp.getProperty('AI_BAD_MODELS') || '{}'); } catch (e) {}
  bad[m] = Date.now(); sp.setProperty('AI_BAD_MODELS', JSON.stringify(bad));
  log_('WARN', 'Gemini modeli kullanılamıyor, atlanıyor: ' + m);
}

/** Birden fazla prompt'u paralel gönderir; başarısız olanları tek tek yeniden dener */
function geminiBatch_(prompts, cfg) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY tanımlı değil (menü > Gemini API key gir).');
  var reqs = prompts.map(function (p) {
    return {
      url: 'https://generativelanguage.googleapis.com/v1beta/models/' + (geminiModels_(cfg, key)[0] || cfg.GEMINI_MODEL) + ':generateContent',
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true,
      payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: p }] }], generationConfig: { responseMimeType: 'application/json' } })
    };
  });
  var res = [];
  try { res = UrlFetchApp.fetchAll(reqs); } catch (e) { res = []; }
  // Faturalandırma / yetki hatası: tüm istekler aynı sebeple düşer → yedek denemeleri yapma
  var fatal = null;
  res.forEach(function (r) {
    var c = r && r.getResponseCode();
    if (!fatal && (c === 402 || c === 401 || c === 403)) fatal = c + ': ' + r.getContentText().slice(0, 400);
  });
  if (fatal) { setAiError_(fatal); return prompts.map(function () { return null; }); }
  // Ücretsiz katman: çok sayıda 429 → bu turu zorlamadan bırak, kartlar "AI bekliyor" kalır ve sonra yeniden denenir
  var n429 = res.filter(function (r) { return r && r.getResponseCode() === 429; }).length;
  if (n429 && n429 >= Math.ceil(prompts.length / 2)) {
    var okIdx = res.map(function (r) { return r && r.getResponseCode() === 200; });
    PropertiesService.getScriptProperties().setProperty('AI_THROTTLE_UNTIL', String(Date.now() + 24 * 3600000));   // 1 gün küçük partiler
    if (!okIdx.some(Boolean)) {
      // tek bir isteği diğer modellerle dene; o da olmazsa 10 dk soğuma
      try { var first = safeJson_(callGemini_(prompts[0], cfg)); PropertiesService.getScriptProperties().setProperty('AI_LAST_OK', new Date().toISOString()); return [first].concat(prompts.slice(1).map(function () { return null; })); }
      catch (e) { PropertiesService.getScriptProperties().setProperty('AI_COOLDOWN_UNTIL', String(Date.now() + 10 * 60000)); setAiError_('429: Gemini kotası doldu (ücretsiz katman olabilir). 10 dk sonra yeniden denenecek.'); return prompts.map(function () { return null; }); }
    }
  }
  var anyOk = false, lastErr = '';
  var out = prompts.map(function (p, i) {
    var r = res[i];
    if (r && r.getResponseCode() === 200) {
      try {
        var j = JSON.parse(r.getContentText());
        var parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
        anyOk = true;
        return safeJson_(parts.map(function (x) { return x.text || ''; }).join(''));
      } catch (e) {}
    }
    try { var a = safeJson_(callGemini_(p, cfg)); anyOk = true; return a; }   // yedek: sıralı + fallback model
    catch (e2) { lastErr = String(e2); return null; }
  });
  if (anyOk) { setAiError_(''); PropertiesService.getScriptProperties().setProperty('AI_LAST_OK', new Date().toISOString()); }
  else if (lastErr) setAiError_(lastErr.slice(0, 400));
  return out;
}

/** Son AI hatası board'da uyarı olarak gösterilir; faturalandırma hatasında 30 dk AI denenmez */
function setAiError_(msg) {
  var sp = PropertiesService.getScriptProperties();
  var prev = sp.getProperty('AI_ERROR') || '';
  if (!msg) { if (prev) sp.deleteProperty('AI_ERROR'); return; }
  sp.setProperty('AI_ERROR', JSON.stringify({ at: new Date().toISOString(), msg: msg }));
  if (!prev) log_('ERROR', 'Gemini çalışmıyor: ' + msg);   // her istek için log basma, bir kez yeter
}
function aiError_() {
  var sp = PropertiesService.getScriptProperties();
  var e = null;
  try { e = JSON.parse(sp.getProperty('AI_ERROR') || 'null'); } catch (x) {}
  if (!e) return null;
  var ok = sp.getProperty('AI_LAST_OK');
  if (ok && new Date(ok) >= new Date(e.at)) return null;          // sonrasında başarılı çağrı olmuş
  return e;
}
/** Board'da gösterilecek uyarı: faturalandırma/yetki hatası hemen, geçici hatalar (429/5xx) 20 dk sürerse */
function aiWarning_() {
  var e = aiError_();
  if (!e) return null;
  if (/^40[123]/.test(e.msg)) return e;
  var ok = PropertiesService.getScriptProperties().getProperty('AI_LAST_OK');
  return (!ok || Date.now() - new Date(ok).getTime() > 20 * 60000) ? e : null;
}
function aiBlocked_() {
  if (Number(PropertiesService.getScriptProperties().getProperty('AI_COOLDOWN_UNTIL') || 0) > Date.now()) return true;   // 429 soğuma
  var e = aiError_();
  return !!(e && /^40[123]/.test(e.msg) && Date.now() - new Date(e.at).getTime() < 30 * 60000);
}

/** AI olmadan, sadece kurallarla geçici sınıflama */
function heuristicAi_(facts) {
  var lastBody = (facts.messages[facts.messages.length - 1] || {}).body || '';
  var status = 'IN_PROGRESS', p = 3;
  if (facts.directToMe && facts.lastSenderRole !== 'ME') { status = 'MY_REPLY'; p = 1; }
  else if (facts.lastToClient) status = 'WAITING_CLIENT';
  else if (facts.lastSenderRole === 'EXTERNAL' && facts.hasCm) status = 'WAITING_CM';
  else if (facts.isDistribution && !facts.hasCm) { status = 'FYI'; }
  return {
    title: facts.subject,
    priority: p,
    priority_reason: 'AI çalışmadı — kurallarla geçici sınıflandı',
    status: status,
    waiting_on: '',
    addressed_to_me: facts.directToMe,
    requires_my_action: false,
    is_real_work: !facts.isMachine,
    summary: '⚠ AI özeti bekleniyor. Son mesaj (' + facts.lastSenderName + '): ' + lastBody.replace(/\s+/g, ' ').slice(0, 280),
    brand: ''
  };
}

function safeJson_(text) {
  var t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) {} }
  }
  return { summary: '(AI yanıtı çözümlenemedi)', status: 'IN_PROGRESS', priority: 3 };
}

// ============================================================
//  SHEET VERİTABANI (başlık adına göre okur → kolon eklemek güvenli)
// ============================================================
function loadDb_() {
  var sh = ss_().getSheetByName(SHEET_TASKS);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var header = sh.getLastRow() >= 1 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  var data = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues() : [];
  var rows = [], byId = {};
  data.forEach(function (r, i) {
    var o = {};
    header.forEach(function (c, j) { if (c) o[c] = r[j] instanceof Date ? r[j].toISOString() : r[j]; });
    if (!o.threadId) return;
    o.threadId = String(o.threadId);
    o._r = i + 2;                       // sheet satır numarası
    rows.push(o); byId[o.threadId] = o;
  });
  var headerOk = header.length >= COLS.length && COLS.every(function (c, i) { return header[i] === c; });
  return { sheet: sh, rows: rows, byId: byId, dirty: false, fullRewrite: !headerOk };
}

/** Kartın durumu ya da önceliği değiştiyse Log'a kaydet: sonradan "bu mail ne zaman, neden bu sütuna düştü" incelenebilsin */
function statusLog_(prev, row, src) {
  try {
    if (!row) return;
    var ps = prev ? prev.status : '', pp = prev ? Number(prev.priority) : 0;
    if (prev && ps === row.status && pp === Number(row.priority) && String(prev.lastMsgId || '') === String(row.lastMsgId || '')) return;
    var lag = row.lastDate ? Math.round((Date.now() - new Date(row.lastDate).getTime()) / 60000) : '';
    log_('INFO', 'Durum' + (src ? ' (' + src + ')' : '') + ': ' + String(row.title || row.subject || '').slice(0, 70) + ' → ' + row.status + ' P' + row.priority +
      (prev ? ' (önce ' + (ps || '?') + ' P' + (pp || '?') + ')' : ' (yeni kart)') + ' · ' + String(row.priorityReason || '').slice(0, 120) +
      ' · son mesaj: ' + (row.lastSender || '?') + (lag !== '' ? ', ' + lag + ' dk önce' : '') + ' [' + row.threadId + ']');
  } catch (e) {}
}
function saveRow_(db, row) {
  var prev = db.byId[row.threadId];
  if (prev && prev !== row) { row._r = prev._r; db.rows[db.rows.indexOf(prev)] = row; }
  else if (!prev) db.rows.push(row);
  db.byId[row.threadId] = row;
  row._dirty = true;
  db.dirty = true;
}

function removeRow_(db, id) {           // artık satır silinmez; geriye uyumluluk için
  var prev = db.byId[id];
  if (prev) { prev.status = 'IGNORED'; prev.closed = true; prev._dirty = true; db.dirty = true; }
}

function rowValues_(o) {
  return COLS.map(function (c) {
    var v = o[c];
    if (v === undefined || v === null) return '';
    if (typeof v === 'string' && v.length > 49000) return v.slice(0, 49000);
    return v;
  });
}

/** Board'dan elle yapılan değişiklikleri işaretler; o sırada çalışan tarama bu satırların üzerine yazmaz */
function markUserEdit_(ids) {
  var o = {}, now = String(Date.now());
  (ids || []).forEach(function (id) { o['edit_' + id] = now; });
  try { CacheService.getScriptCache().putAll(o, 3600); } catch (e) {}
}

/** Sadece değişen satırları yazar, yenileri sona ekler (binlerce satırda tüm sheet'i yeniden yazmaz) */
function flushDb_(db) {
  if (!db.dirty && !db.fullRewrite) return;
  var sh = db.sheet;
  // Arka plan işi (tarama/aktarım) başladıktan sonra kullanıcı board'dan bir kartı değiştirdiyse o satırı ezme
  if (db.guardSince) {
    var keys = db.rows.filter(function (r) { return r._dirty && r._r; }).map(function (r) { return 'edit_' + r.threadId; });
    var edits = {};
    for (var k = 0; k < keys.length; k += 100) { try { Object.assign(edits, CacheService.getScriptCache().getAll(keys.slice(k, k + 100))); } catch (e) {} }
    var clash = false;
    db.rows.forEach(function (r) {
      var t = edits['edit_' + r.threadId];
      if (r._dirty && r._r && t && Number(t) >= db.guardSince) { r._dirty = false; clash = true; }  // sonraki turda yeniden işlenir
    });
    if (clash && db.fullRewrite) db.fullRewrite = false;   // kullanıcı düzenlerken tüm sheet'i baştan yazma; sonraki turda
  }
  if (db.fullRewrite) {
    var all = db.rows.map(rowValues_);
    sh.clearContents();
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (all.length) sh.getRange(2, 1, all.length, COLS.length).setNumberFormat('@').setValues(all);
    db.rows.forEach(function (r, i) { r._r = i + 2; r._dirty = false; });
    db.fullRewrite = false; db.dirty = false;
    return;
  }
  var changed = db.rows.filter(function (r) { return r._dirty && r._r; }).sort(function (a, b) { return a._r - b._r; });
  // Ardışık satırları tek seferde yaz
  for (var i = 0; i < changed.length;) {
    var j = i;
    while (j + 1 < changed.length && changed[j + 1]._r === changed[j]._r + 1) j++;
    var block = changed.slice(i, j + 1);
    sh.getRange(block[0]._r, 1, block.length, COLS.length).setNumberFormat('@').setValues(block.map(rowValues_));
    block.forEach(function (r) { r._dirty = false; });
    i = j + 1;
  }
  var added = db.rows.filter(function (r) { return !r._r; });
  if (added.length) {
    var startRow = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(startRow, 1, added.length, COLS.length).setNumberFormat('@').setValues(added.map(rowValues_));
    added.forEach(function (r, k) { r._r = startRow + k; r._dirty = false; });
  }
  db.dirty = false;
}

function pruneDb_() { /* Tüm mailler sheet'te kalır; silme yok */ }

function log_(level, msg) {
  try {
    var sh = ss_().getSheetByName(SHEET_LOG);
    if (!sh) return;
    sortLogOnce_(sh);
    // En yeni kayıt en üstte (başlığın hemen altı)
    sh.insertRowBefore(2);
    sh.getRange(2, 1, 1, 3).setValues([[new Date(), level, String(msg).slice(0, 2000)]]);
    if (sh.getLastRow() > 1500) sh.deleteRows(1301, sh.getLastRow() - 1300);
  } catch (e) {}
  console.log(level + ': ' + msg);
}

/** Eski (eskiden yeniye) Log kayıtlarını bir kez yeniden eskiye çevirir */
function sortLogOnce_(sh) {
  var sp = PropertiesService.getScriptProperties();
  if (sp.getProperty('LOG_DESC') === '1') return;
  var n = sh.getLastRow() - 1;
  if (n > 1) sh.getRange(2, 1, n, 3).sort({ column: 1, ascending: false });
  sh.setFrozenRows(1);
  sp.setProperty('LOG_DESC', '1');
}

// ============================================================
//  WEB APP (Board)
// ============================================================
function boardPage_() {   // doGet Setup.gs içinde: kurulum bittiyse Board açılır
  return HtmlService.createHtmlOutputFromFile('Board')
    .setTitle('Mail Board')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function toCard_(r) {
  return {
    id: r.threadId, subject: r.subject, title: r.title, brand: r.brand,
    cm: r.cm, cmEmail: r.cmEmail, priority: Number(r.priority) || 5,
    priorityReason: r.priorityReason, status: r.status, aiStatus: r.aiStatus,
    closed: isTrue_(r.closed), closedAt: r.closedAt, closedBy: r.closedBy,
    summary: r.summary, clientAsk: r.clientAsk, cmResponse: r.cmResponse,
    nextAction: r.nextAction, suggestedReply: r.suggestedReply,
    participants: r.participants, lastSender: r.lastSender, lastSenderRole: r.lastSenderRole,
    firstDate: r.firstDate, lastDate: r.lastDate, msgCount: Number(r.msgCount) || 1,
    addressedToMe: isTrue_(r.addressedToMe), flags: r.flags, link: r.link, lastMsgId: r.lastMsgId || '',
    remindedAt: r.remindedAt || '', followUp: isTrue_(r.followUp),
    recentMine: (r.recentMine === '' || r.recentMine == null) ? r.lastSenderRole === 'ME' : isTrue_(r.recentMine)
  };
}

/**
 * Reklam önizleme linkinden oynatılabilir video çıkarır (maildeki linkin üzerine gelince board'da oynatılır).
 * TikTok: önizleme sayfasının kullandığı herkese açık uç noktaya preview_token ile sorulur, giriş gerektirmez.
 * Meta (fb.me/adspreview): Facebook girişi gerektirir, sunucudan açılamaz → board küçük pencerede açmayı önerir.
 */
function getAdPreview(url) {
  url = String(url || '');
  var m = url.match(/[?&]preview_token=([^&#]+)/);
  if (/ads\.tiktok\.com\/[^?]*preview/i.test(url) && m) {
    var token = decodeURIComponent(m[1]);
    var tm = url.match(/[?&]type=(\d+)/), type = tm ? Number(tm[1]) : 0;
    var cache = CacheService.getScriptCache();
    var key = 'ttp:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, token + '|' + type));
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
    var res = UrlFetchApp.fetch('https://ads.tiktok.com/api/v4/i18n/creation/preview/spp/detail/', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ preview_token: token, type: type })
    });
    var j = {};
    try { j = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
    if (j.code !== 0 || !j.data) return { type: 'tiktok', error: j.msg || ('TikTok yanıt vermedi (HTTP ' + res.getResponseCode() + ')') };
    // Standart ve "smart" kreatiflerde yapı farklı olabiliyor → ilk play_url / cover_url'ü bul
    var found = {};
    (function walk(o) {
      if (!o || typeof o !== 'object' || (found.video && found.cover)) return;
      if (o.play_url && !found.video) { found.video = o.play_url; found.w = o.width; found.h = o.height; }
      if (o.cover_url && !found.cover) found.cover = o.cover_url;
      for (var k in o) walk(o[k]);
    })(j.data);
    if (!found.cover) { var im = (((j.data.manual_data || {}).image_infos) || [])[0]; if (im && im.url) found.cover = im.url; }
    var out = { type: 'tiktok', video: found.video || '', cover: found.cover || '', width: found.w || 0, height: found.h || 0 };
    if (!out.video && !out.cover) out.error = 'Önizlemede video bulunamadı';
    cache.put(key, JSON.stringify(out), 1800);          // video linkleri imzalı ve süreli: 30 dk önbellek
    return out;
  }
  if (/fb\.me\/adspreview|facebook\.com\/ads\/(experience|preview)/i.test(url)) return { type: 'meta', needsLogin: true };
  return { type: 'unknown' };
}

/** Analiz sayfası: her konuşma için [ilk mesaj tarihi, CM, tür]. Board bunu tarayıcıda gün/hafta/ay kırılımına çevirir. */
function getAnalyticsData() {
  var cfg = getConfig_();
  var db = loadDb_();
  var since = '';
  var rows = db.rows.filter(function (r) { return r.status !== 'IGNORED' && r.firstDate; }).map(function (r) {
    var d = r.firstDate instanceof Date ? r.firstDate.toISOString() : String(r.firstDate);
    if (!since || d < since) since = d;
    return [d, r.cm || 'Atanmamış', r.aiStatus || r.status || ''];
  });
  return { rows: rows, cms: cfg.cms.map(function (c) { return c.name; }), since: since };
}

function getBoardData() {
  var cfg = getConfig_();
  var db = loadDb_();
  var limit = Date.now() - cfg.closedVisibleDays * 86400000;
  var cards = db.rows.filter(function (r) {
    if (r.status === 'IGNORED' || STATUSES.indexOf(r.status) < 0) return false;
    return !isTrue_(r.closed) || new Date(r.closedAt || r.updatedAt).getTime() > limit;
  }).map(function (r) { applyStale_(r, cfg); return toCard_(r); });
  return {
    cards: cards,
    cms: cfg.cms.map(function (c) { return { name: c.name, email: c.email }; }),
    statuses: STATUSES.filter(function (s) { return cfg.hiddenCols.indexOf(s) < 0; }).map(function (s) {
      var nm = cfg.colNames[s] || String(STATUS_NAMES[s]).replace(/\bCM\b/g, cfg.teamShort);
      if (!cfg.colNames[s] && s === 'STALE') nm = nm.replace(/^3\+/, cfg.staleDays + '+');
      if (!cfg.colNames[s] && s === 'CLIENT_STALE') nm = nm.replace(/5\+/, (cfg.clientStaleDays || 5) + '+');
      return { id: s, name: nm };
    }),
    filterBy: cfg.filterBy,
    brands: cfg.brandMap.map(function (b) { return b.name; }),
    teamShort: cfg.teamShort,
    priorities: [1, 2, 3, 4, 5].map(function (p) { return { id: p, name: PRIORITY_NAMES[p] }; }),
    slaHours: cfg.slaHours,
    staleDays: cfg.staleDays,
    reminderText: cfg.reminderText,
    lastSync: PropertiesService.getScriptProperties().getProperty('LAST_SYNC') || '',
    appUrl: (function () { try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; } })(),
    columnOrder: getColumnOrder_(),
    signatureText: (function () { try { return getSignature_(cfg).text; } catch (e) { return ''; } })(),
    aiError: aiWarning_(),
    syncError: (function () { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('SYNC_ERROR') || 'null'); } catch (e) { return null; } })(),
    me: cfg.myEmail,
    todos: (function () { try { return readTodos_(); } catch (e) { return []; } })(),
    seen: (function () { try { return boardSeen_(db, cards); } catch (e) { return null; } })(),
    serverTime: new Date().toISOString(),
    planned: (function () { try { return planBoard_(); } catch (e) { return {}; } })()
  };
}

// ============================================================
//  PANO OKUNMA DURUMU — Gmail'den bağımsız: kartı panoda açınca o anki son mesaj "görüldü" olarak kaydedilir.
//  Sonra yeni bir mesaj gelirse (son mesaj değişirse) kart "Yeni mesaj" olarak işaretlenir.
// ============================================================
var SEEN_COLS = ['threadId', 'msgId', 'at'];
function seenSheet_() {
  var ss = ss_(), sh = ss.getSheetByName(SHEET_SEEN);
  if (!sh) {
    sh = ss.insertSheet(SHEET_SEEN);
    sh.getRange(1, 1, 1000, SEEN_COLS.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, SEEN_COLS.length).setValues([SEEN_COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function readSeenRows_() {
  var sh = seenSheet_(), n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, SEEN_COLS.length).getDisplayValues().filter(function (r) { return r[0]; }) : [];
}
/** Board'a gösterilen kartlar için görülme haritası. İlk çalışmada mevcut tüm kartlar "görülmüş" sayılır. */
function boardSeen_(db, cards) {
  var sp = PropertiesService.getScriptProperties();
  if (sp.getProperty('SEEN_SEEDED') !== '1') {
    var now = new Date().toISOString();
    var seed = cards.filter(function (c) { return c.lastMsgId; }).map(function (c) { return [c.id, c.lastMsgId, now]; });
    var sh = seenSheet_();
    if (seed.length) sh.getRange(sh.getLastRow() + 1, 1, seed.length, SEEN_COLS.length).setNumberFormat('@').setValues(seed);
    sp.setProperty('SEEN_SEEDED', '1');
  }
  var ids = {}; cards.forEach(function (c) { ids[c.id] = 1; });
  var map = {};
  readSeenRows_().forEach(function (r) { if (ids[r[0]]) map[r[0]] = r[1]; });
  return map;
}
/** pairs: [[threadId, lastMsgId], ...] — panoda açılan kartlar */
function markSeen(pairs) {
  if (!pairs || !pairs.length) return 0;
  var lock = LockService.getUserLock(); lock.waitLock(15000);
  try {
    var sh = seenSheet_(), rows = readSeenRows_(), idx = {}, now = new Date().toISOString();
    rows.forEach(function (r, i) { idx[r[0]] = i; });
    var add = [];
    pairs.forEach(function (p) {
      var tid = String(p[0] || ''), mid = String(p[1] || ''); if (!tid) return;
      if (idx[tid] != null) { rows[idx[tid]][1] = mid; rows[idx[tid]][2] = now; }
      else { idx[tid] = rows.length; rows.push([tid, mid, now]); add.push(1); }
    });
    // Büyümesin: 3000 kaydı geçerse en yeni 2000'i tut
    if (rows.length > 3000) { rows.sort(function (a, b) { return a[2] < b[2] ? 1 : -1; }); rows = rows.slice(0, 2000); sh.getRange(2, 1, sh.getMaxRows() - 1, SEEN_COLS.length).clearContent(); }
    if (rows.length) sh.getRange(2, 1, rows.length, SEEN_COLS.length).setNumberFormat('@').setValues(rows);
    return pairs.length;
  } finally { lock.releaseLock(); }
}

// ============================================================
//  YAPILACAKLAR (kişisel hatırlatıcı listesi) — "Todos" sayfasında tutulur
// ============================================================
var TODO_COLS = ['id', 'title', 'due', 'dueTime', 'done', 'doneAt', 'threadId', 'threadTitle', 'createdAt', 'updatedAt'];
function todoSheet_() {
  var ss = ss_(), sh = ss.getSheetByName(SHEET_TODOS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_TODOS);
    sh.getRange(1, 1, 1000, TODO_COLS.length).setNumberFormat('@');      // tarihler metin kalsın, Sheets dönüştürmesin
    sh.getRange(1, 1, 1, TODO_COLS.length).setValues([TODO_COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function readTodos_() {
  var sh = todoSheet_(), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var limit = new Date(Date.now() - 30 * 86400000).toISOString();
  return sh.getRange(2, 1, n, TODO_COLS.length).getDisplayValues().map(function (r) {
    var t = {}; TODO_COLS.forEach(function (c, i) { t[c] = r[i]; });
    t.done = /^true$/i.test(t.done);
    return t;
  }).filter(function (t) { return t.id && (!t.done || !t.doneAt || t.doneAt > limit); });   // 30 günden eski tamamlananlar gösterilmez
}
function saveTodo(t) {
  if (!t || !t.id) throw new Error('Geçersiz hatırlatıcı');
  var lock = LockService.getUserLock(); lock.waitLock(15000);
  try {
    var sh = todoSheet_(), n = sh.getLastRow() - 1;
    var ids = n > 0 ? sh.getRange(2, 1, n, 1).getDisplayValues().map(function (r) { return r[0]; }) : [];
    var row = TODO_COLS.map(function (c) { var v = t[c]; if (c === 'done') return v ? 'TRUE' : ''; return v == null ? '' : String(v).slice(0, 500); });
    var i = ids.indexOf(String(t.id));
    if (i >= 0) sh.getRange(i + 2, 1, 1, TODO_COLS.length).setNumberFormat('@').setValues([row]);
    else sh.getRange(sh.getLastRow() + 1, 1, 1, TODO_COLS.length).setNumberFormat('@').setValues([row]);
    return t;
  } finally { lock.releaseLock(); }
}
function deleteTodo(id) {
  var lock = LockService.getUserLock(); lock.waitLock(15000);
  try {
    var sh = todoSheet_(), n = sh.getLastRow() - 1;
    if (n < 1) return false;
    var ids = sh.getRange(2, 1, n, 1).getDisplayValues().map(function (r) { return r[0]; });
    var i = ids.indexOf(String(id));
    if (i >= 0) sh.deleteRow(i + 2);
    return i >= 0;
  } finally { lock.releaseLock(); }
}

/** Kullanıcının board'da ayarladığı kolon sırası (hesabına kaydedilir, tüm cihazlarda aynı) */
function getColumnOrder_() {
  try { return JSON.parse(PropertiesService.getUserProperties().getProperty('COLUMN_ORDER') || '[]'); } catch (e) { return []; }
}
function saveColumnOrder(order) {
  var clean = (order || []).filter(function (s) { return STATUSES.indexOf(s) >= 0 || s === 'TIMELINE' || s === 'TODO'; });
  if (clean.length) PropertiesService.getUserProperties().setProperty('COLUMN_ORDER', JSON.stringify(clean));
  else PropertiesService.getUserProperties().deleteProperty('COLUMN_ORDER');
  return clean;
}

function moveOne_(db, cfg, threadId, newStatus) {
  var row = db.byId[String(threadId)];
  if (!row) throw new Error('Kart bulunamadı: ' + threadId);
  // Thread'i indirmeye gerek yok (eskiden her kartta tam thread çekiliyordu → toplu taşımada dakikalık kota doluyordu).
  // Label/okundu işlemleri tek bir Threads.modify ile yapılır; thread silinmişse 404 yok sayılır.
  var th = apiThread_(row.threadId);
  var gone = function (e) { return /not found|404/i.test(String(e)); };

  if (CLOSED_STATUSES.indexOf(newStatus) >= 0) {
    var rm = boardLabelIds_().concat(['STARRED']);
    if (cfg.markReadOnClose) rm.push('UNREAD');
    try { th.modifyLabels([], rm); } catch (e) { if (!gone(e)) throw e; }   // tek istek: label'lar + yıldız + okundu
    markClosed_(row, newStatus, 'board');
    row.followUp = false;
  } else {
    var wasClosed = isTrue_(row.closed);
    row.closed = false; row.closedAt = ''; row.closedBy = '';
    row.status = newStatus;
    if (newStatus === 'REMINDED' || newStatus === 'STALE') {
      row.followUp = true; row.manualStatus = '';
      if (newStatus === 'REMINDED') row.remindedAt = new Date().toISOString();
    } else {
      row.followUp = false;
      row.manualStatus = newStatus;
    }
    row.updatedAt = new Date().toISOString();
    try {
      applyBoardLabels_(th, row, cfg);
      if (wasClosed && !isSticky_(newStatus)) th.markUnread();   // Yakın Takip okunmuş olsa da açık kalır, maili okunmadı yapmaya gerek yok
    } catch (e) { if (!gone(e)) throw e; }
  }
  saveRow_(db, row);
  return toCard_(row);
}

/** Tek kart taşıma (geri uyumluluk) */
function moveCard(threadId, newStatus) {
  return moveCards([threadId], newStatus)[0];
}

/** Çoklu seçim ile toplu taşıma */
function moveCards(ids, newStatus) {
  if (STATUSES.indexOf(newStatus) < 0) throw new Error('Geçersiz durum');
  // Board işlemleri arka plan taramasını/aktarımı BEKLEMEZ (ayrı kilit). Çakışmada kullanıcının değişikliği kazanır.
  var lock = LockService.getUserLock(); lock.waitLock(15000);
  markUserEdit_(ids);
  try {
    var cfg = getConfig_();
    var db = loadDb_();
    var out = [];
    (ids || []).forEach(function (id) {
      try { out.push(moveOne_(db, cfg, id, newStatus)); }
      catch (e) { log_('ERROR', 'Taşıma hatası ' + id + ': ' + e); }
    });
    flushDb_(db);
    return out;
  } finally { lock.releaseLock(); }
}

/** Detay panelinden öncelik / CM değiştirme */
function updateCard(threadId, changes) {
  var lock = LockService.getUserLock(); lock.waitLock(15000);
  markUserEdit_([threadId]);
  try {
    var cfg = getConfig_();
    var db = loadDb_();
    var row = db.byId[String(threadId)];
    if (!row) throw new Error('Kart bulunamadı');
    if (changes.priority) {
      row.priority = Math.max(1, Math.min(5, parseInt(changes.priority, 10)));
      if (!isTrue_(row.closed) && !isJiraStatus_(row.status)) {
        if (row.priority === 4) row.status = 'INTERNAL';
        else if (row.priority === 5) row.status = 'AUTO';
        else if (row.status === 'INTERNAL' || row.status === 'AUTO') row.status = 'FYI';
        row.manualStatus = row.status;
      }
    }
    if (changes.cmEmail !== undefined) {
      var c = cfg.cms.filter(function (x) { return x.email === lc_(changes.cmEmail); })[0];
      row.cm = c ? c.name : 'Atanmamış'; row.cmEmail = c ? c.email : '';
    }
    row.updatedAt = new Date().toISOString();
    if (!isTrue_(row.closed)) {
      var th = apiThread_(row.threadId);
      if (th.exists()) applyBoardLabels_(th, row, cfg);
    }
    saveRow_(db, row); flushDb_(db);
    return toCard_(row);
  } finally { lock.releaseLock(); }
}

// ------------------------------------------------------------
//  Konuşmanın tamamı: HTML gövde + görseller (en yeni en üstte)
//  Temizleme (alıntı, imza, yasal uyarı) board tarafında DOM ile yapılır.
//  Gmail Advanced Service gerekir (Services > Gmail API).
// ------------------------------------------------------------
var MAX_IMG_BYTES = 1500000;
var MAX_THREAD_IMG_BYTES = 8000000;

function getThreadDetail(threadId) {
  var cfg = getConfig_();
  var th = apiThread_(String(threadId));
  if (!th.exists()) return { messages: [] };
  // Thread zaten format=full ile tek istekte geliyor: mesajları ayrıca indirmiyoruz.
  var list = th.getMessages().filter(function (m) { return !m.isDraft(); }).reverse();   // en yeni en üstte
  var parsed = list.map(function (m) { return parseMsgParts_(m._m); });
  // Görseller: bütçe en yeni mesajdan başlayarak dağıtılır, tüm ekler tek seferde paralel indirilir
  var budget = MAX_THREAD_IMG_BYTES, jobs = [];
  parsed.forEach(function (p, i) {
    p.imgs.forEach(function (ip) {
      if (!ip.size || ip.size > MAX_IMG_BYTES || ip.size > budget) return;
      budget -= ip.size;
      if (ip.data) ip.dataUri = toDataUri_(ip.mime, ip.data);
      else if (ip.attachmentId) jobs.push({ ip: ip, msgId: list[i].getId() });
    });
  });
  fetchAttachments_(jobs);
  var msgs = list.map(function (m, i) {
    var p = parsed[i], html = p.html, images = [];
    p.imgs.forEach(function (ip) {
      if (ip.cid && html.indexOf('cid:' + ip.cid) >= 0) html = html.split('cid:' + ip.cid).join(ip.dataUri || 'about:blank');
      else images.push({ name: ip.name, src: ip.dataUri || '', size: ip.size });
    });
    var f = parseAddresses_(m.getFrom())[0] || { name: m.getFrom(), email: '' };
    return {
      id: m.getId(),
      from: f.name || f.email, fromEmail: f.email, role: roleOf_(f.email, cfg),
      to: m.getTo(), cc: m.getCc(),
      date: m.getDate().toISOString(),
      html: html,
      text: html ? '' : cleanBody_(m.getPlainBody() || '').slice(0, 6000),
      images: images
    };
  });
  var subj = ''; try { subj = list.length ? list[list.length - 1].getSubject() : ''; } catch (e) {}
  return { messages: msgs, subject: subj };
}

/** Mesaj gövdesini (html / düz metin) ve görsel parçalarını ayırır; ağ isteği yapmaz */
function parseMsgParts_(raw) {
  var htmlPart = null, textPart = null, imgs = [];
  (function walk(p) {
    if (!p) return;
    var mime = lc_(p.mimeType || '');
    var headers = {};
    (p.headers || []).forEach(function (h) { headers[lc_(h.name)] = h.value; });
    var attach = /attachment/i.test(headers['content-disposition'] || '');
    if (mime === 'text/html' && !htmlPart && !attach) htmlPart = p;
    else if (mime === 'text/plain' && !textPart && !attach) textPart = p;
    else if (mime.indexOf('image/') === 0) {
      imgs.push({
        mime: mime, size: (p.body && p.body.size) || 0,
        data: p.body && p.body.data, attachmentId: p.body && p.body.attachmentId,
        cid: String(headers['content-id'] || headers['x-attachment-id'] || '').replace(/^<|>$/g, ''),
        name: p.filename || 'görsel', dataUri: ''
      });
    }
    (p.parts || []).forEach(walk);
  })(raw && raw.payload);
  var decode = function (data) {
    var bytes = typeof data === 'string' ? Utilities.base64DecodeWebSafe(data) : data;
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  };
  var html = htmlPart && htmlPart.body && htmlPart.body.data ? decode(htmlPart.body.data) : '';
  if (!html && textPart && textPart.body && textPart.body.data) {
    html = '<div style="white-space:pre-wrap">' + escHtml_(decode(textPart.body.data)) + '</div>';
  }
  return { html: html, imgs: imgs };
}

function toDataUri_(mime, data) {
  var b64 = typeof data === 'string' ? data.replace(/-/g, '+').replace(/_/g, '/') : Utilities.base64Encode(data);
  return 'data:' + mime + ';base64,' + b64;
}

/** Ek görselleri Gmail REST API'den paralel indirir (sırayla indirmek uzun thread'lerde saniyeler sürüyordu) */
function fetchAttachments_(jobs) {
  if (!jobs.length) return;
  var token = ScriptApp.getOAuthToken();
  for (var i = 0; i < jobs.length; i += 20) {
    var chunk = jobs.slice(i, i + 20);
    var res = null;
    try {
      res = UrlFetchApp.fetchAll(chunk.map(function (j) {
        return { url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + j.msgId + '/attachments/' + j.ip.attachmentId,
                 headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
      }));
    } catch (e) { res = null; }
    chunk.forEach(function (j, k) {
      try {
        var data = null;
        if (res && res[k].getResponseCode() === 200) data = JSON.parse(res[k].getContentText()).data;
        else data = Gmail.Users.Messages.Attachments.get('me', j.msgId, j.ip.attachmentId).data;   // yedek yol
        if (data) j.ip.dataUri = toDataUri_(j.ip.mime, data);
      } catch (e) { /* görsel gösterilemez, mesaj yine gelir */ }
    });
  }
}

function escHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Önerilen cevabı Gmail'de "Tümünü yanıtla" taslağı olarak oluşturur */
// ------------------------------------------------------------
//  Kendi cevabın: alıcıları seç (Kime/Cc), taslak oluştur ya da gönder
// ------------------------------------------------------------
/** Varsayılan "tümünü yanıtla" alıcıları + thread'deki herkes (seçenek olarak) */
function getReplyRecipients(threadId) {
  var cfg = getConfig_();
  var th = GmailApp.getThreadById(String(threadId));
  if (!th) throw new Error('Thread bulunamadı');
  var msgs = th.getMessages().filter(function (m) { return !m.isDraft(); });
  var last = msgs[msgs.length - 1];
  var P = function (s) { return parseAddresses_(s || ''); };
  var opts = {}, order = [];
  var add = function (a) { var e = lc_(a.email || ''); if (!e || e === cfg.myEmail) return; if (!opts[e]) { opts[e] = { email: e, name: a.name || '', role: roleOf_(e, cfg) }; order.push(e); } else if (!opts[e].name && a.name) opts[e].name = a.name; };
  msgs.forEach(function (m) { P(m.getFrom()).concat(P(m.getTo()), P(m.getCc())).forEach(add); });
  var from = P(last.getFrom())[0] || {}, lastTo = P(last.getTo()), lastCc = P(last.getCc());
  var to, cc;
  if (lc_(from.email || '') === cfg.myEmail) { to = lastTo; cc = lastCc; }          // son mesaj benimse aynı kişilere
  else { to = [from]; cc = lastTo.concat(lastCc); }
  var clean = function (arr, not) { var seen = {}; return arr.map(function (a) { return lc_(a.email || ''); }).filter(function (e) { if (!e || e === cfg.myEmail || seen[e] || (not && not.indexOf(e) >= 0)) return false; seen[e] = 1; return true; }); };
  to = clean(to); cc = clean(cc, to);
  return { to: to, cc: cc, options: order.map(function (e) { return opts[e]; }) };
}
function buildReplyMimeHtml_(from, toList, ccList, lastMsg, text, html) {
  var subj = lastMsg.getSubject() || '';
  if (!/^(re|ynt|yanıt|cevap)\s*:/i.test(subj)) subj = 'Re: ' + subj;
  var msgId = lastMsg.getHeader('Message-ID') || lastMsg.getHeader('Message-Id') || '';
  var refs = lastMsg.getHeader('References') || '';
  var enc = function (x) { return '=?UTF-8?B?' + Utilities.base64Encode(Utilities.newBlob(x).getBytes()) + '?='; };
  var b = 'mb_' + Utilities.getUuid().replace(/-/g, '');
  var lines = ['From: ' + from, 'To: ' + toList.join(', ')];
  if (ccList.length) lines.push('Cc: ' + ccList.join(', '));
  lines.push('Subject: ' + enc(subj), 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="' + b + '"');
  if (msgId) { lines.push('In-Reply-To: ' + msgId); lines.push('References: ' + (refs ? refs + ' ' : '') + msgId); }
  var part = function (type, body) { return '--' + b + '\r\nContent-Type: ' + type + '; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Utilities.base64Encode(Utilities.newBlob(body).getBytes()) + '\r\n'; };
  var mime = lines.join('\r\n') + '\r\n\r\n' + part('text/plain', text) + part('text/html', html) + '--' + b + '--';
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(mime).getBytes());
}
/** mode: 'draft' → Gmail'de taslak, 'send' → gönder. to/cc: e-posta listeleri */
/** Kullanıcı board'dan bu kartı `since` (ms) sonrasında değiştirdi mi? (taşıma, öncelik, CM…) */
function userEditedSince_(threadId, since) {
  if (!since) return false;
  try { var t = CacheService.getScriptCache().get('edit_' + threadId); return !!t && Number(t) >= Number(since) - 2000; } catch (e) { return false; }
}
function sendReply(threadId, body, to, cc, mode, sentAt) {
  var cfg = getConfig_();
  var ok = function (e) { return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(e); };
  to = (to || []).map(function (e) { return lc_(String(e).trim()); }).filter(ok);
  cc = (cc || []).map(function (e) { return lc_(String(e).trim()); }).filter(function (e) { return ok(e) && to.indexOf(e) < 0; });
  if (!to.length) throw new Error('En az bir "Kime" alıcısı seç');
  var text = String(body || '').replace(/\s+$/, '');
  if (!text) throw new Error('Mesaj boş');
  var th = GmailApp.getThreadById(String(threadId));
  if (!th) throw new Error('Thread bulunamadı');
  var msgs = th.getMessages().filter(function (m) { return !m.isDraft(); });
  var last = msgs[msgs.length - 1];
  var sig = getSignature_(cfg);
  var html = '<div dir="ltr">' + escHtml_(text).replace(/\n/g, '<br>') + '</div>' +
             (sig.html ? '<div class="gmail_signature" data-smartmail="gmail_signature">' + tightSig_(sig.html) + '</div>' : '');
  var raw = buildReplyMimeHtml_(mailbox_(cfg.MY_NAME, cfg.myEmail), to, cc, last, text + (sig.text ? '\n' + sig.text : ''), html);
  var resource = { raw: raw, threadId: String(threadId) };
  var card = null;
  if (mode === 'send') {
    Gmail.Users.Messages.send(resource, 'me'); log_('INFO', 'Cevap gönderildi: ' + threadId + ' → ' + to.concat(cc).join(', '));
    // Board'dan cevap verdin: CM yerine işi üstlendin → CM beklenmez, iş devam ediyor (sonraki taramada AI yeniden değerlendirir)
    try {
      var lock = LockService.getUserLock(); lock.waitLock(15000);
      try {
        var db = loadDb_(), row = db.byId[String(threadId)];
        if (row && !isTrue_(row.closed)) {
          row.lastSender = cfg.MY_NAME || cfg.myEmail; row.lastSenderRole = 'ME'; row.lastDate = new Date().toISOString(); row.recentMine = true;
          if (!userEditedSince_(threadId, sentAt) && ['MY_REPLY', 'WAITING_CM', 'STALE', 'REMINDED', 'CLIENT_STALE'].indexOf(row.status) >= 0 && row.status !== 'WATCH') {
            row.status = 'IN_PROGRESS'; row.aiStatus = 'IN_PROGRESS'; row.manualStatus = ''; row.followUp = false; row.suggestedReply = '';
            row.priorityReason = 'Cevabı sen verdin, işi üstlendin';
          }
          row.updatedAt = new Date().toISOString();
          saveRow_(db, row); flushDb_(db); card = toCard_(row);
        }
      } finally { lock.releaseLock(); }
    } catch (e) { log_('WARN', 'Gönderim sonrası kart güncellenemedi: ' + e); }
  }
  else Gmail.Users.Drafts.create({ message: resource }, 'me');
  return { link: gmailLink_(threadId, cfg), mode: mode === 'send' ? 'send' : 'draft', from: cfg.MY_NAME || cfg.myEmail, at: new Date().toISOString(), sig: sig.text || '', card: card };
}

/** Board: cevap gönderildikten hemen sonra kartı, cevabın içeriğine göre AI ile yeniden sınıfla */
/** Board: cevap gönderildikten sonra durumu yenile. Hata olursa board'a hata fırlatmaz:
 *  nedeni Log'a yazılır, kart bir sonraki taramada (AI ile) yeniden sınıflanacak şekilde işaretlenir. */
function refreshAfterReply(threadId, sentAt) {
  try { return refreshAfterReplyCore_(threadId, sentAt); }
  catch (e) {
    try { log_('ERROR', 'refreshAfterReply ' + threadId + ': ' + (e && e.message || e) + (e && e.stack ? '\n' + String(e.stack).slice(0, 800) : '')); } catch (x) {}
    try {
      var lock = LockService.getUserLock(); lock.waitLock(10000);
      try { var db = loadDb_(), row = db.byId[String(threadId)]; if (row && !isTrue_(row.closed)) { row.msgCount = ''; saveRow_(db, row); flushDb_(db); } }
      finally { lock.releaseLock(); }
    } catch (x) {}
    var r0 = null; try { r0 = loadDb_().byId[String(threadId)]; } catch (x) {}
    var card = r0 ? toCard_(r0) : null;
    if (card) card.refreshDeferred = true;
    return card;
  }
}
function refreshAfterReplyCore_(threadId, sentAt) {
  var cfg = getConfig_(), id = String(threadId);
  var row0 = loadDb_().byId[id];
  if (!row0 || isTrue_(row0.closed) || aiBlocked_()) return row0 ? toCard_(row0) : null;
  var th = apiThread_(id); if (!th || !th.exists()) return toCard_(row0);
  var facts = extractFacts_(th, cfg, row0);
  if (facts.lastSenderRole !== 'ME') return toCard_(row0);          // gönderilen mesaj henüz thread'de görünmüyor
  var ai = geminiBatch_([buildPrompt_(facts, cfg)], cfg)[0];
  if (!ai) return toCard_(row0);
  var lock = LockService.getUserLock(); lock.waitLock(28000);
  try {
    var db = loadDb_(), row = db.byId[id] || row0;
    var newRow = processThread_(th, facts, cfg, row, ai);
    meetingNotesOverride_(newRow, facts.lastSenderEmail, facts.subject);
    newRow.memory = String(ai.memory || row.memory || '').slice(0, 12000);
    newRow.factsCache = JSON.stringify(facts.cache).slice(0, 45000);
    var userMoved = userEditedSince_(id, sentAt);   // gönderdikten sonra durumu board'dan sen değiştirdiysen o kalır
    if (userMoved) { newRow.status = row.status; newRow.aiStatus = row.aiStatus; newRow.manualStatus = row.manualStatus; newRow.priority = row.priority; newRow.closed = row.closed; newRow.followUp = row.followUp; }
    else if (isSticky_(row.manualStatus)) { newRow.status = row.manualStatus; newRow.manualStatus = row.manualStatus; }
    else if (row.status === 'STALE' || row.status === 'REMINDED' || isTrue_(row.followUp)) { newRow.status = 'REMINDED'; newRow.followUp = true; newRow.remindedAt = facts.lastDate; }
    else newRow.followUp = false;
    if (!userMoved) applyStale_(newRow, cfg);
    if (userMoved || !closeIfIFinished_(newRow, th, cfg)) {
      try { applyBoardLabels_(th, newRow, cfg); } catch (e) { log_('WARN', 'Label güncellenemedi: ' + e); }
    }
    statusLog_(row, newRow, 'cevap sonrası'); saveRow_(db, newRow); flushDb_(db);
    return toCard_(newRow);
  } finally { lock.releaseLock(); }
}

// ------------------------------------------------------------
//  TOPLANTI NOTLARI (Circleback): Hemen Cevapla'ya düşer, tek tuşla BIZ katılımcılarına iletilir
// ------------------------------------------------------------
var MEETING_NOTES_FROM = /@circleback\.ai$/i;
function isMeetingNotes_(fromEmail, subject) { return MEETING_NOTES_FROM.test(String(fromEmail || '')) && /^\s*(notes for|toplantı notları)\b/i.test(String(subject || '')); }
function meetingTitle_(subject) { return String(subject || '').replace(/^\s*(fwd?|ilt|re)\s*:\s*/i, '').replace(/^\s*notes for\s*/i, '').trim(); }
function meetingNotesOverride_(row, fromEmail, subject) {
  if (!row || !isMeetingNotes_(fromEmail, subject) || isTrue_(row.closed)) return;
  row.status = 'MY_REPLY'; row.aiStatus = 'MY_REPLY'; row.manualStatus = '';
  row.priority = Math.min(Number(row.priority) || 2, 2);
  row.title = 'Toplantı notu: ' + meetingTitle_(subject);
  row.priorityReason = 'Circleback toplantı notu — BIZ katılımcılarına ilet';
  row.nextAction = 'Notu toplantıya katılan BIZ ekibine ilet.';
  row.suggestedReply = '';
  if (String(row.flags || '').indexOf('MEETING_NOTES') < 0) row.flags = (row.flags ? row.flags + ',' : '') + 'MEETING_NOTES';
}
function normTitle_(t) { return foldTr_(String(t || '').replace(/&amp;/g, '&')).replace(/[^a-z0-9]+/g, ' ').trim(); }
/** Toplantının takvim davetini bulup BIZ'den katılımcıları döndürür */
function getMeetingAttendees(threadId) {
  var cfg = getConfig_();
  var th = GmailApp.getThreadById(String(threadId));
  if (!th) throw new Error('Thread bulunamadı');
  var msg = th.getMessages().filter(function (m) { return isMeetingNotes_(lc_((parseAddresses_(m.getFrom())[0] || {}).email || ''), m.getSubject()); })[0] || th.getMessages()[0];
  var title = meetingTitle_(msg.getSubject()), want = normTitle_(title), at = msg.getDate();
  var best = null, bestScore = -1;
  var cals = [CalendarApp.getDefaultCalendar()];
  try { CalendarApp.getAllCalendars().forEach(function (c) { if (c.getId() !== cals[0].getId() && c.isOwnedByMe && c.isOwnedByMe()) cals.push(c); }); } catch (e) {}
  cals.forEach(function (cal) {
    var evs = []; try { evs = cal.getEvents(new Date(at.getTime() - 36 * 3600000), new Date(at.getTime() + 2 * 3600000)); } catch (e) {}
    evs.forEach(function (ev) {
      var t = normTitle_(ev.getTitle()); if (!t) return;
      var sc = t === want ? 3 : (t.indexOf(want) >= 0 || want.indexOf(t) >= 0 ? 2 : 0);
      if (!sc) return;
      var gap = Math.abs(at.getTime() - ev.getEndTime().getTime()) / 3600000;   // not toplantı bitince gelir
      var score = sc * 100 - gap;
      if (score > bestScore) { bestScore = score; best = ev; }
    });
  });
  var sem = [], others = 0, seen = {};
  var push = function (email, name) {
    email = lc_(email || ''); if (!email || seen[email] || email === cfg.myEmail) return; seen[email] = 1;
    var dom = email.split('@')[1] || '';
    if (cfg.internalDomains.indexOf(dom) >= 0 && !/^(mt|ad|tokyo|all|ekip|team)@/.test(email) && !/resource\.calendar/.test(email)) sem.push({ email: email, name: name || '' });
    else others++;
  };
  if (best) {
    try { best.getGuestList(true).forEach(function (g) { if (String(g.getGuestStatus()) !== 'NO') push(g.getEmail(), g.getName && g.getName()); }); } catch (e) {}
    try { push(best.getCreators()[0]); } catch (e) {}
  }
  // Daha önce bu toplantının notunu kime ilettiysen onlar da önerilir (davet bulunamazsa işe yarar)
  var prev = [];
  try {
    GmailApp.search('in:sent subject:"' + title.replace(/"/g, '') + '" newer_than:90d', 0, 5).forEach(function (t2) {
      t2.getMessages().forEach(function (m) { if (lc_((parseAddresses_(m.getFrom())[0] || {}).email || '') === cfg.myEmail && /^\s*fwd?:/i.test(m.getSubject())) parseAddresses_(m.getTo()).concat(parseAddresses_(m.getCc() || '')).forEach(function (a) { prev.push(lc_(a.email)); }); });
    });
  } catch (e) {}
  return { meeting: title, eventFound: !!best, eventTitle: best ? best.getTitle() : '', when: best ? best.getStartTime().toISOString() : '', sem: sem, others: others,
           previous: prev.filter(function (e, i, a) { return e && a.indexOf(e) === i && e !== cfg.myEmail && !seen[e]; }) };
}
/** Toplantı notunu seçilen kişilere ilet; kart Done olur */
function forwardMeetingNotes(threadId, to) {
  var cfg = getConfig_();
  var ok = function (e) { return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(e); };
  to = (to || []).map(function (e) { return lc_(String(e).trim()); }).filter(ok);
  if (!to.length) throw new Error('İletilecek kimse seçilmedi');
  var th = GmailApp.getThreadById(String(threadId));
  if (!th) throw new Error('Thread bulunamadı');
  var msg = th.getMessages().filter(function (m) { return isMeetingNotes_(lc_((parseAddresses_(m.getFrom())[0] || {}).email || ''), m.getSubject()); })[0];
  if (!msg) throw new Error('Toplantı notu maili bulunamadı');
  msg.forward(to.join(','));
  log_('INFO', 'Toplantı notu iletildi: ' + meetingTitle_(msg.getSubject()) + ' → ' + to.join(', '));
  var lock = LockService.getUserLock(); lock.waitLock(15000);
  try { var db = loadDb_(); moveOne_(db, cfg, threadId, 'DONE'); flushDb_(db); } finally { lock.releaseLock(); }
  return { sent: to.length };
}

function createReplyDraft(threadId, body) {
  var th = GmailApp.getThreadById(String(threadId));
  if (!th) throw new Error('Thread bulunamadı');
  var cfg = getConfig_();
  var msgs = th.getMessages();
  var sig = getSignature_(cfg);
  var text = String(body || '').replace(/\s+$/, '');
  var html = '<div dir="ltr">' + escHtml_(text).replace(/\n/g, '<br>') + '</div>' +
             (sig.html ? '<div class="gmail_signature" data-smartmail="gmail_signature">' + tightSig_(sig.html) + '</div>' : '');
  msgs[msgs.length - 1].createDraftReplyAll(text + (sig.text ? '\n' + sig.text : ''), { htmlBody: html });
  return gmailLink_(threadId, cfg);
}

/** Gmail'de tanımlı imza (Ayarlar > İmza). 6 saat önbellekte tutulur. */
/** İmzanın başındaki boş satırları/boşlukları at: "Sevgiler,"den hemen sonra imza gelsin */
function tightSig_(h) {
  var re = /^((?:<(?:div|p|span)[^>]*>)*?)(?:\s|&nbsp;|<br\s*\/?>|<(div|p|span)[^>]*>\s*(?:&nbsp;|<br\s*\/?>)?\s*<\/\2>)+/i;
  var t = String(h || ''), prev = null;
  while (t !== prev) { prev = t; t = t.replace(re, '$1'); }
  return t;
}
function getSignature_(cfg) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('SIGNATURE');
  if (hit) return JSON.parse(hit);
  var sig = { html: '', text: '' };
  try {
    var list = Gmail.Users.Settings.SendAs.list('me').sendAs || [];
    var mine = list.filter(function (s) { return lc_(s.sendAsEmail) === cfg.myEmail; })[0] || list.filter(function (s) { return s.isDefault; })[0];
    if (mine && mine.signature) {
      sig.html = mine.signature;
      sig.text = mine.signature.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
    }
  } catch (e) { log_('WARN', 'İmza okunamadı: ' + e); }
  cache.put('SIGNATURE', JSON.stringify(sig), 21600);
  return sig;
}

// ------------------------------------------------------------
//  3+ iş günü bekleyenler: SADECE sorumlu CM'e thread içinde hatırlatma
//  mode: 'draft' → taslak oluşturur, 'send' → gönderir
// ------------------------------------------------------------
function remindCms(ids, mode, text) {
  var cfg = getConfig_();
  var body = String(text || '').trim() || cfg.reminderText;   // pencerede düzenlenen metin, boşsa varsayılan
  var lock = LockService.getUserLock(); lock.waitLock(15000);
  markUserEdit_(ids);
  try {
    var db = loadDb_();
    var results = [];
    (ids || []).forEach(function (id) {
      var row = db.byId[String(id)];
      try {
        if (!row) throw new Error('Kart bulunamadı');
        if (!row.cmEmail) throw new Error('CM atanmamış');
        var th = apiThread_(row.threadId);
        if (!th.exists()) throw new Error('Thread bulunamadı');
        var msgs = th.getMessages().filter(function (m) { return !m.isDraft(); });
        var last = msgs[msgs.length - 1];
        var raw = buildReplyMime_(mailbox_(cfg.MY_NAME, cfg.myEmail), mailbox_(row.cm, row.cmEmail), last, body);
        var resource = { raw: raw, threadId: row.threadId };
        if (mode === 'send') Gmail.Users.Messages.send(resource, 'me');
        else Gmail.Users.Drafts.create({ message: resource }, 'me');
        row.remindedAt = new Date().toISOString();
        if (mode === 'send') { row.status = 'REMINDED'; row.followUp = true; row.manualStatus = ''; }
        saveRow_(db, row);
        results.push({ id: id, ok: true, card: toCard_(row) });
      } catch (e) {
        results.push({ id: id, ok: false, error: String(e.message || e) });
      }
    });
    flushDb_(db);
    return { results: results, draftsLink: 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(cfg.myEmail) + '#drafts' };
  } finally { lock.releaseLock(); }
}

/** "Ad Soyad <mail>" başlığı (Türkçe karakterler için RFC 2047 kodlu) */
function mailbox_(name, email) {
  name = String(name || '').trim();
  if (!name || name === 'Atanmamış' || name.indexOf('@') >= 0) return email;
  return '=?UTF-8?B?' + Utilities.base64Encode(Utilities.newBlob(name).getBytes()) + '?= <' + email + '>';
}

function buildReplyMime_(from, to, lastMsg, text) {
  var subj = lastMsg.getSubject() || '';
  if (!/^(re|ynt|yanıt|cevap)\s*:/i.test(subj)) subj = 'Re: ' + subj;
  var msgId = lastMsg.getHeader('Message-ID') || lastMsg.getHeader('Message-Id') || '';
  var refs = lastMsg.getHeader('References') || '';
  var enc = function (s) { return '=?UTF-8?B?' + Utilities.base64Encode(Utilities.newBlob(s).getBytes()) + '?='; };
  var lines = [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + enc(subj),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ];
  if (msgId) {
    lines.push('In-Reply-To: ' + msgId);
    lines.push('References: ' + (refs ? refs + ' ' : '') + msgId);
  }
  var mime = lines.join('\r\n') + '\r\n\r\n' + Utilities.base64Encode(Utilities.newBlob(text).getBytes());
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(mime).getBytes());
}

/** Elle tarama: saatlik tam kontrolü de hemen yapar (kapalı ama okunmamış kartları geri açar vb.) */
function syncNowFull() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_FULL_CHECK');
  syncMail();
}

function runSyncNow() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_FULL_CHECK');
  syncMail();
  return getBoardData();
}

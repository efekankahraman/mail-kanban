/**
 * Otomatik kurulum (clasp ile yüklendiğinde). Kullanıcı Sheet'e hiç girmeden:
 * board linkini açar → Google izni verir → bu sayfada Gemini key'i yapıştırır → board açılır.
 * BOOT_SPREADSHEET_ID, kurulumda clasp'in oluşturduğu Sheet'in ID'si ile doldurulur.
 */
var BOOT_SPREADSHEET_ID = '';

function doGet(e) {
  var sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('SPREADSHEET_ID') && BOOT_SPREADSHEET_ID) sp.setProperty('SPREADSHEET_ID', BOOT_SPREADSHEET_ID);
  if (sp.getProperty('GEMINI_API_KEY') && sp.getProperty('AUTO_SETUP_DONE') === '1') return boardPage_();
  var t = HtmlService.createTemplate(ONBOARD_HTML_);
  t.hasKey = !!sp.getProperty('GEMINI_API_KEY');
  return t.evaluate().setTitle('Mail Board · Kurulum').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Onboarding sayfasından çağrılır: ayarlar, key, tetikleyiciler, ilk tarama, (opsiyonel) dijital ikiz. */
function completeSetup(key, twin) {
  var sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('SPREADSHEET_ID') && BOOT_SPREADSHEET_ID) sp.setProperty('SPREADSHEET_ID', BOOT_SPREADSHEET_ID);
  key = String(key || '').trim();
  if (key) { sp.setProperty('GEMINI_API_KEY', key); sp.deleteProperty('AI_ERROR'); }
  if (!sp.getProperty('GEMINI_API_KEY')) throw new Error('Gemini API key gerekli.');
  setup();                       // sayfalar, ayarlar, label'lar (UI yoksa uyarıyı atlar)
  installTrigger();              // 10 dk tarama + geçmiş aktarımı
  oneShot_('firstSync_', 5);
  if (twin) oneShot_('twinOnce_', 60);
  sp.setProperty('AUTO_SETUP_DONE', '1');
  return ScriptApp.getService().getUrl();
}

function oneShot_(fn, sec) { ScriptApp.newTrigger(fn).timeBased().after(sec * 1000).create(); }
function dropOneShot_(fn) { ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); }); }
function firstSync_() { dropOneShot_('firstSync_'); syncNowFull(); }
function twinOnce_() { dropOneShot_('twinOnce_'); buildDigitalTwin(); }

var ONBOARD_HTML_ = [
  '<!doctype html><html><head><meta charset="utf-8"><style>',
  'body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f5f4;color:#1c1917;margin:0;padding:16px}',
  '.c{max-width:520px;margin:40px auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}',
  'h1{font-size:22px;margin:0 0 6px}p{line-height:1.5;color:#44403c}input[type=text]{width:100%;box-sizing:border-box;padding:12px;border:1px solid #d6d3d1;border-radius:8px;font-size:15px}',
  'button{margin-top:16px;width:100%;padding:13px;border:0;border-radius:8px;background:#1c1917;color:#fff;font-size:15px;cursor:pointer}button:disabled{opacity:.5}',
  'label{display:flex;gap:8px;align-items:flex-start;margin-top:14px;font-size:14px;color:#44403c}a{color:#2563eb}#m{margin-top:12px;font-size:14px}',
  '</style></head><body><div class="c"><h1>Mail Board kurulumu</h1>',
  '<p>Son adım: Gemini API key. <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a> adresinden "Create API key" ile al ve buraya yapıştır.</p>',
  '<input id="k" type="text" placeholder="<?= hasKey ? "Key kayıtlı — değiştirmek için yapıştır" : "AIza..." ?>" autocomplete="off">',
  '<label><input id="t" type="checkbox" checked> Dijital ikiz: gönderdiğim maillerden üslubumu öğren, cevap taslaklarını benim gibi yaz.</label>',
  '<button id="b" onclick="go()">Kurulumu tamamla</button><div id="m"></div></div>',
  '<script>function go(){var b=document.getElementById("b"),m=document.getElementById("m");b.disabled=true;m.textContent="Kuruluyor…";',
  'google.script.run.withSuccessHandler(function(u){m.innerHTML="Hazır. İlk tarama birkaç dakika içinde kartları getirecek. Board açılıyor…";setTimeout(function(){window.top.location.href=u;},1500);})',
  '.withFailureHandler(function(e){b.disabled=false;m.textContent="Hata: "+e.message;}).completeSetup(document.getElementById("k").value,document.getElementById("t").checked);}</script>',
  '</body></html>'
].join('\n');

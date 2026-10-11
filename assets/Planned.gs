/**
 * ============================================================
 *  PLANLI JIRA YORUMLARI — yorumu şimdi yaz, Jira'ya ileri bir saatte gitsin
 * ============================================================
 *  - Kart üzerinden (Jira bildirimi kartı ya da mail kartının Jira kutusu) yazılan yorum
 *    "🕒 Planla" ile seçilen saate planlanır. Saati gelince addJiraComment ile yazılır:
 *    etiketler (@), ekler ve [[E#]] gömülü görseller o an yüklenir, kart durumu yorumun içeriğine göre güncellenir.
 *  - Zamanlama: her zaman en yakın planlı yorum için TEK bir "at" tetikleyicisi tutulur
 *    (+ 10 dk'lık onay tetikleyicisi yedek kontrol yapar). Birkaç dakika sapma olabilir.
 *  - Gönderim, kullanıcının planlarken verdiği onaya dayanır; planlı yorum düzenlenebilir, iptal edilebilir, hemen yazılabilir.
 *  Kayıtlar "Planlı" sayfasında: id | threadId | key | at | state | createdAt | updatedAt | data(JSON)
 *  state: PLANNED → SENDING → SENT | FAILED | CANCELED
 */
var SHEET_PLAN = 'Planlı';
var PLAN_HEAD = ['id', 'threadId', 'key', 'at', 'state', 'createdAt', 'updatedAt', 'data'];

function planSheet_() {
  var ss = ss_(), sh = ss.getSheetByName(SHEET_PLAN);
  if (!sh) {
    sh = ss.insertSheet(SHEET_PLAN);
    sh.getRange(1, 1, 1, PLAN_HEAD.length).setValues([PLAN_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function planIso_(v) { return v instanceof Date ? v.toISOString() : String(v || ''); }
function planAll_() {
  var sh = planSheet_(), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, PLAN_HEAD.length).getValues().map(function (r, i) {
    var d = {}; try { d = JSON.parse(r[7] || '{}'); } catch (e) {}
    return { _r: i + 2, id: String(r[0]), threadId: String(r[1]), key: String(r[2]), at: planIso_(r[3]), state: String(r[4]),
      createdAt: planIso_(r[5]), updatedAt: planIso_(r[6]), data: d };
  });
}
function planWrite_(it) {
  var sh = planSheet_();
  var row = [it.id, it.threadId, it.key, it.at, it.state, it.createdAt, new Date().toISOString(), JSON.stringify(it.data || {}).slice(0, 45000)];
  if (it._r) sh.getRange(it._r, 1, 1, row.length).setValues([row]);
  else { sh.appendRow(row); it._r = sh.getLastRow(); }
  planMemo_ = null;
}
/** Düzenlenebilir/gönderilebilir mi? (SENDING'de 10 dk'dan uzun takılı kalan da kurtarılabilir) */
function planEditable_(it) { return it.state === 'PLANNED' || it.state === 'FAILED' || (it.state === 'SENDING' && Date.now() - new Date(it.updatedAt).getTime() > 600000); }
function planFind_(id) { return planAll_().filter(function (x) { return x.id === String(id); })[0] || null; }
/** Sayfa şişmesin: 400 satırı geçince en eski kapanmış (SENT/CANCELED) kayıtları sil */
function planTrim_() {
  var sh = planSheet_(), n = sh.getLastRow(); if (n < 450) return;
  var all = planAll_(), del = all.filter(function (x) { return x.state === 'SENT' || x.state === 'CANCELED'; }).slice(0, n - 400);
  del.reverse().forEach(function (x) { sh.deleteRow(x._r); });
  planMemo_ = null;
}
/** Board'a gidecek görünüm */
function planView_(it) {
  var d = it.data || {};
  return { id: it.id, threadId: it.threadId, key: it.key, at: it.at, state: it.state, text: d.text || '',
    atts: (d.atts || []).length, title: d.title || '', error: d.error || '', url: d.url || '' };
}
var planMemo_ = null;
/** threadId → açık (PLANNED/FAILED) planlı yorumlar */
function planOpenByThread_() {
  if (planMemo_) return planMemo_;
  var map = {};
  planAll_().forEach(function (it) {
    if (it.state !== 'PLANNED' && it.state !== 'FAILED' && it.state !== 'SENDING') return;
    (map[it.threadId] = map[it.threadId] || []).push(planView_(it));
  });
  Object.keys(map).forEach(function (k) { map[k].sort(function (a, b) { return a.at < b.at ? -1 : 1; }); });
  planMemo_ = map;
  return map;
}
function planHas_(threadId) { try { return !!(planOpenByThread_()[String(threadId)] || []).some(function (p) { return p.state === 'PLANNED'; }); } catch (e) { return false; } }
/** getBoardData için */
function planBoard_() { return planOpenByThread_(); }

/** En yakın planlı yorum için tek bir "at" tetikleyicisi (eskileri silinir) */
function planEnsureTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'runPlannedComments') ScriptApp.deleteTrigger(t); });
  var next = null;
  planAll_().forEach(function (it) { if (it.state === 'PLANNED') { var t = new Date(it.at).getTime(); if (t && (next === null || t < next)) next = t; } });
  if (next === null) return;
  ScriptApp.newTrigger('runPlannedComments').timeBased().at(new Date(Math.max(next, Date.now() + 60000))).create();
}

/** Board: yorumu ileri bir saate planla */
function scheduleJiraComment(issueKey, body, mentions, attachments, threadId, atIso) {
  var m = String(issueKey || '').toUpperCase().match(JIRA_KEY_RE_);
  if (!m) throw new Error('Geçerli bir iş anahtarı gir (ör. GRPADS-2219)');
  if (!String(body || '').trim()) throw new Error('Yorum boş');
  if (!jiraCreds_()) throw new Error('Jira bağlı değil');
  var at = new Date(atIso), t = at.getTime();
  if (!t || t < Date.now() + 60000) throw new Error('İleri bir zaman seç (en az 1 dk sonrası)');
  if (t > Date.now() + 90 * 86400000) throw new Error('En fazla 90 gün sonrasına planlanabilir');
  var row = threadId ? loadDb_().byId[String(threadId)] : null;
  var atts = (attachments || []).map(function (a) { return { id: a.id, name: a.name, mime: a.mime, size: a.size, ref: a.ref || '', image: !!a.image }; });
  var it = { id: 'pl' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), threadId: String(threadId || ''), key: m[1], at: at.toISOString(),
    state: 'PLANNED', createdAt: new Date().toISOString(),
    data: { text: String(body), mentions: mentions || {}, atts: atts, title: row ? String(row.title || row.subject || '') : '' } };
  planWrite_(it);
  try { planTrim_(); } catch (e) {}
  planEnsureTrigger_();
  log_('INFO', 'Jira yorumu planlandı: ' + m[1] + ' → ' + Utilities.formatDate(at, 'Europe/Istanbul', 'dd.MM.yyyy HH:mm'));
  return planView_(it);
}
/** Board: planlı yorumu düzenle (metin ve/veya saat) */
function editPlannedComment(id, body, atIso) {
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var it = planFind_(id); if (!it) throw new Error('Planlı yorum bulunamadı');
    if (!planEditable_(it)) throw new Error('Bu yorum artık düzenlenemez (' + it.state + ')');
    if (body !== undefined && body !== null) { if (!String(body).trim()) throw new Error('Yorum boş'); it.data.text = String(body); }
    if (atIso) {
      var t = new Date(atIso).getTime();
      if (!t || t < Date.now() + 60000) throw new Error('İleri bir zaman seç (en az 1 dk sonrası)');
      it.at = new Date(t).toISOString();
    }
    it.state = 'PLANNED'; delete it.data.error;
    planWrite_(it);
  } finally { lock.releaseLock(); }
  planEnsureTrigger_();
  return planView_(it);
}
/** Board: planlı yorumu iptal et */
function cancelPlannedComment(id) {
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    var it = planFind_(id); if (!it) throw new Error('Planlı yorum bulunamadı');
    if (!planEditable_(it)) throw new Error('Bu yorum zaten ' + (it.state === 'SENT' ? 'yazıldı' : it.state === 'SENDING' ? 'yazılıyor' : 'kapandı'));
    it.state = 'CANCELED'; planWrite_(it);
  } finally { lock.releaseLock(); }
  planEnsureTrigger_();
  return planView_(it);
}
/** Board: planlı yorumu beklemeden şimdi yaz */
function sendPlannedNow(id) {
  var r = planSend_(id);
  planEnsureTrigger_();
  return r;
}
/** Tek bir planlı yorumu yaz. SENDING ile kilitlenir, iki kez gitmez. */
function planSend_(id) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  var it;
  try {
    it = planFind_(id); if (!it) throw new Error('Planlı yorum bulunamadı');
    if (!planEditable_(it)) throw new Error('Bu yorum zaten ' + (it.state === 'SENT' ? 'yazıldı' : it.state === 'SENDING' ? 'yazılıyor' : 'kapandı'));
    it.state = 'SENDING'; planWrite_(it);
  } finally { lock.releaseLock(); }
  try {
    var r = addJiraComment(it.key, it.data.text, it.data.mentions || {}, it.data.atts || [], it.threadId || null);
    it.state = 'SENT'; it.data.url = r.url || ''; it.data.sentAt = new Date().toISOString(); delete it.data.error;
    planWrite_(it);
    log_('INFO', 'Planlı Jira yorumu yazıldı: ' + it.key + (r.effect ? ' (' + r.effect + ')' : ''));
    return { item: planView_(it), res: r };
  } catch (e) {
    it.state = 'FAILED'; it.data.error = String(e.message || e).slice(0, 300); it.data.tries = (it.data.tries || 0) + 1;
    planWrite_(it);
    log_('WARN', 'Planlı Jira yorumu yazılamadı ' + it.key + ': ' + it.data.error);
    throw e;
  }
}
/** Tetikleyici: saati gelen planlı yorumları yaz. Hata alan yorum FAILED kalır, kartta görünür (tekrar dene / düzenle). */
function runPlannedComments() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  var due;
  try {
    var now = Date.now() + 30000;
    due = planAll_().filter(function (it) { return it.state === 'PLANNED' && new Date(it.at).getTime() <= now; });
  } finally { lock.releaseLock(); }
  due.forEach(function (it) { try { planSend_(it.id); } catch (e) {} });
  try { planEnsureTrigger_(); } catch (e) { log_('WARN', 'Planlı yorum tetikleyicisi kurulamadı: ' + e); }
}
/** Yedek kontrol (10 dk'lık tetikleyiciden çağrılır): saati geçmiş planlı yorum varsa yaz */
function planDueCheck_() {
  var any = planAll_().some(function (it) { return it.state === 'PLANNED' && new Date(it.at).getTime() <= Date.now() + 30000; });
  if (any) runPlannedComments();
}

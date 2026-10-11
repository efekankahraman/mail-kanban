/**
 * ============================================================
 *  ONAYLAR — AI işleri hazırlar, kullanıcı tek tuşla onaylar
 * ============================================================
 *  - Aksiyon gereken kartlar (Hemen Cevapla) için AI öneri hazırlar:
 *      MAIL          → maile cevap (alıcılar + metin)
 *      JIRA_COMMENT  → Jira bildirimi kartında task'e yorum (etiketleme dahil)
 *  - Aynı anda en fazla APPROVAL_LIMIT (varsayılan 5) hazır öneri tutulur.
 *    Biri onaylanınca/geçilince arkadan bir yenisi hazırlanır (token boşa gitmez).
 *  - Öneri hazırlandığı andaki son mesaja bağlıdır: thread'e yeni mesaj gelirse
 *    öneri bayatlar (STALE) ve gönderilmez; kullanıcı isterse yeniden hazırlanır.
 *  - Gönderim sadece kullanıcı onaylayınca yapılır (board 15 sn "Geri al" süresi tanır).
 *  Kayıtlar "Onaylar" sayfasında: id | threadId | type | state | basisMsgId | createdAt | updatedAt | data(JSON)
 */
var SHEET_APPR = 'Onaylar';
var APPR_HEAD = ['id', 'threadId', 'type', 'state', 'basisMsgId', 'createdAt', 'updatedAt', 'data'];

function apprLimit_() {
  var n = parseInt(getConfig_().APPROVAL_LIMIT, 10);
  return n >= 1 && n <= 30 ? n : 5;
}
function apprSheet_() {
  var ss = ss_(), sh = ss.getSheetByName(SHEET_APPR);
  if (!sh) {
    sh = ss.insertSheet(SHEET_APPR);
    sh.getRange(1, 1, 1, APPR_HEAD.length).setValues([APPR_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function apprAll_() {
  var sh = apprSheet_(), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, APPR_HEAD.length).getValues().map(function (r, i) {
    var d = {}; try { d = JSON.parse(r[7] || '{}'); } catch (e) {}
    return { _r: i + 2, id: String(r[0]), threadId: String(r[1]), type: String(r[2]), state: String(r[3]), basisMsgId: String(r[4]),
      createdAt: r[5] instanceof Date ? r[5].toISOString() : String(r[5]), updatedAt: r[6] instanceof Date ? r[6].toISOString() : String(r[6]), data: d };
  });
}
function apprWrite_(it) {
  var sh = apprSheet_();
  var row = [it.id, it.threadId, it.type, it.state, it.basisMsgId, it.createdAt, new Date().toISOString(), JSON.stringify(it.data || {}).slice(0, 45000)];
  if (it._r) sh.getRange(it._r, 1, 1, row.length).setValues([row]);
  else { sh.appendRow(row); it._r = sh.getLastRow(); }
  // Sayfa şişmesin: 600 satırı geçince en eski kapanmış kayıtları sil
  var n = sh.getLastRow();
  if (n > 700) sh.deleteRows(2, n - 600);
}
function apprFind_(id) { return apprAll_().filter(function (x) { return x.id === String(id); })[0] || null; }

/** Kart öneri almaya uygun mu? (açık, Hemen Cevapla, takvim/toplantı notu değil, AI sırası beklemiyor) */
function apprEligible_(row) {
  if (!row || isTrue_(row.closed) || row.status !== 'MY_REPLY' || !row.lastMsgId || row.msgCount === '') return false;
  var fl = String(row.flags || '');
  if (/(^|,)(CALENDAR|CAL_RESPONSE|MEETING_NOTES|AI_PENDING)(,|$)/.test(fl)) return false;
  if (row.lastSenderRole === 'ME') return false;
  if (typeof planHas_ === 'function' && planHas_(row.threadId)) return false;   // planlı yorumu var: öneri hazırlama
  return true;
}
function apprTypeOf_(row) {
  var key = (String(row.subject || '').match(JIRA_KEY_RE_) || [])[1] || '';
  if (/(^|,)JIRA(,|$)/.test(String(row.flags || '')) && key) return jiraCreds_() ? { type: 'JIRA_COMMENT', key: key } : null;
  return { type: 'MAIL' };
}
function apprLastMsgId_(threadId) {
  var th = GmailApp.getThreadById(String(threadId)); if (!th) return '';
  var ms = th.getMessages().filter(function (m) { return !m.isDraft(); });
  return ms.length ? ms[ms.length - 1].getId() : '';
}
/** Bir kart için öneri metnini hazırla (AI çağrısı) */
function apprBuild_(row, t, hint) {
  var base = { title: row.title || row.subject, subject: row.subject, brand: row.brand || '', cm: row.cm || '',
    reason: row.priorityReason || '', summary: row.summary || '', nextAction: row.nextAction || '', lastSender: row.lastSender || '', lastDate: row.lastDate || '' };
  if (t.type === 'JIRA_COMMENT') {
    var j = generateJiraComment(row.threadId, t.key, hint || '');
    var attPick = (j.attachments || []).filter(function (a) { return (j.attach || []).indexOf(a.id) >= 0; }).map(function (a) { return { id: a.id, name: a.name, mime: a.mime, size: a.size, ref: a.ref, image: a.image }; });
    return Object.assign(base, { key: j.key, url: j.url, text: j.comment, people: j.people || {}, state: j.state || '', aiNote: j.reason || '', atts: attPick });
  }
  var rc = getReplyRecipients(row.threadId);
  var text = generateAiReply(row.threadId, hint || '', { to: rc.to, cc: rc.cc });
  return Object.assign(base, { to: rc.to, cc: rc.cc, options: rc.options, text: text });
}
/** Mutex: aynı anda iki öneri üretimi çalışmasın (tarama ile çakışmamak için ScriptLock kullanılmıyor) */
function apprBusy_(set) {
  var c = CacheService.getUserCache();
  if (set === true) { if (c.get('APPR_GEN')) return true; c.put('APPR_GEN', '1', 150); return false; }
  if (set === false) { c.remove('APPR_GEN'); return false; }
  return !!c.get('APPR_GEN');
}

/** Hazır öneri sayısı limitin altındaysa EN FAZLA `max` yeni öneri hazırla. */
function apprFill_(max, deadlineMs) {
  if (aiBlocked_()) return { added: 0, more: false, reason: 'ai' };
  if (apprBusy_(true)) return { added: 0, more: true, busy: true };
  var added = 0;
  try {
    var limit = apprLimit_();
    while (added < max && (!deadlineMs || Date.now() < deadlineMs)) {
      var all = apprAll_();
      var ready = all.filter(function (x) { return x.state === 'READY' || x.state === 'SENDING'; });
      if (ready.length >= limit) return { added: added, more: false };
      var used = {}; all.forEach(function (x) { used[x.threadId + '|' + x.basisMsgId] = 1; if (x.state === 'READY' || x.state === 'SENDING') used[x.threadId] = 1; });
      var db = loadDb_();
      var cand = db.rows.filter(function (r) { return apprEligible_(r) && !used[r.threadId] && !used[r.threadId + '|' + r.lastMsgId]; });
      cand.sort(function (a, b) { return (Number(a.priority) || 5) - (Number(b.priority) || 5) || new Date(b.lastDate) - new Date(a.lastDate); });
      var row = null, t = null;
      for (var i = 0; i < cand.length && !row; i++) { var tt = apprTypeOf_(cand[i]); if (tt) { row = cand[i]; t = tt; } }
      if (!row) return { added: added, more: false, empty: true };
      var it = { id: 'ap' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), threadId: String(row.threadId), type: t.type,
        state: 'READY', basisMsgId: String(row.lastMsgId), createdAt: new Date().toISOString(), data: {} };
      try { it.data = apprBuild_(row, t, ''); }
      catch (e) {
        // Hazırlanamadı: aynı mesaj için tekrar denenmesin (yeni mesaj gelince yeniden aday olur)
        it.state = 'FAILED'; it.data = { title: row.title || row.subject, error: String(e && e.message || e).slice(0, 300) };
        log_('WARN', 'Onay önerisi hazırlanamadı (' + row.threadId + '): ' + it.data.error);
      }
      apprWrite_(it);
      if (it.state === 'READY') added++;
    }
    return { added: added, more: true };
  } finally { apprBusy_(false); }
}
/** Zamanlayıcı: hazır öneri yoksa/azsa tamamla (en fazla ~4 dk) */
function fillApprovalsTick() {
  try { planDueCheck_(); } catch (e) { log_('WARN', 'Planlı yorum kontrolü: ' + e); }   // planlı Jira yorumları için yedek kontrol
  try { apprFill_(10, Date.now() + 240000); } catch (e) { log_('WARN', 'Onay önerileri hazırlanamadı: ' + e); }
}
function apprEnsureTrigger_() {
  var sp = PropertiesService.getScriptProperties();
  if (sp.getProperty('APPR_TRIGGER') === '1') return;
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'fillApprovalsTick'; });
  if (!has) ScriptApp.newTrigger('fillApprovalsTick').timeBased().everyMinutes(10).create();
  sp.setProperty('APPR_TRIGGER', '1');
}

/** Board: hazır öneriler (bayatlayanlar burada elenir) */
function getApprovals() {
  try { apprEnsureTrigger_(); } catch (e) {}
  var db = loadDb_(), all = apprAll_(), out = [], limit = apprLimit_();
  all.forEach(function (it) {
    // Gönderim yarıda kaldıysa (çalışma zaman aşımı vb.) 10 dk sonra öneriyi geri getir
    if (it.state === 'SENDING' && Date.now() - new Date(it.updatedAt).getTime() > 600000) { it.state = 'READY'; apprWrite_(it); }
    if (it.state !== 'READY') return;
    var row = db.byId[it.threadId];
    // Kart kapandı, durumu değişti (ör. board'dan cevap verildi) ya da thread'e yeni mesaj geldi → öneri bayat
    if (!row || isTrue_(row.closed) || row.status !== 'MY_REPLY' || (row.lastMsgId && String(row.lastMsgId) !== it.basisMsgId)) {
      it.state = 'STALE'; apprWrite_(it); return;
    }
    out.push({ id: it.id, threadId: it.threadId, type: it.type, createdAt: it.createdAt, data: it.data, priority: Number(row.priority) || 5, cardStatus: row.status });
  });
  out.sort(function (a, b) { return a.priority - b.priority || new Date(b.data.lastDate) - new Date(a.data.lastDate); });
  var since = Date.now() - 86400000;
  var doneToday = all.filter(function (x) { return x.state === 'DONE' && new Date(x.updatedAt).getTime() > since; }).length;
  var waiting = db.rows.filter(function (r) { return apprEligible_(r); }).length;
  return { items: out.slice(0, limit), limit: limit, doneToday: doneToday, busy: apprBusy_(), eligible: waiting, aiBlocked: aiBlocked_() };
}
/** Board: eksik öneriyi arkadan tamamla (her çağrıda en fazla 1 yeni öneri; board boşluk kaldıkça tekrar çağırır) */
function refillApprovals() {
  var r = apprFill_(1, Date.now() + 200000);
  return r;
}
/** Board: öneriyi kullanıcı notuyla yeniden yaz (isteğe bağlı, token harcar) */
function regenApproval(id, hint) {
  var it = apprFind_(id); if (!it) throw new Error('Öneri bulunamadı');
  var row = loadDb_().byId[it.threadId]; if (!row) throw new Error('Kart bulunamadı');
  var t = it.type === 'JIRA_COMMENT' ? { type: 'JIRA_COMMENT', key: it.data.key || ((String(row.subject).match(JIRA_KEY_RE_) || [])[1]) } : { type: 'MAIL' };
  it.data = apprBuild_(row, t, hint || '');
  it.basisMsgId = String(row.lastMsgId || it.basisMsgId); it.state = 'READY';
  apprWrite_(it);
  return { id: it.id, threadId: it.threadId, type: it.type, data: it.data };
}
/** Board: öneriyi geç (bu mesaj için bir daha önerilmez; yeni mesaj gelirse tekrar aday olur) */
function skipApproval(id) {
  var it = apprFind_(id); if (!it) return { ok: true };
  if (it.state === 'READY') { it.state = 'SKIPPED'; apprWrite_(it); }
  return { ok: true };
}
/**
 * Board: onayla ve uygula. edits: {text, to, cc, key, force}
 * Gönderimden hemen önce thread'in son mesajı canlı kontrol edilir: öneri hazırlandıktan sonra yeni mesaj geldiyse
 * (force değilse) gönderilmez, {stale:true} döner.
 */
function approveApproval(id, edits) {
  edits = edits || {};
  var lock = LockService.getUserLock(); lock.waitLock(20000);
  var it;
  try {
    it = apprFind_(id); if (!it) throw new Error('Öneri bulunamadı');
    if (it.state === 'DONE') return { ok: true, already: true };
    if (it.state !== 'READY') throw new Error('Bu öneri artık geçerli değil (' + it.state + ')');
    var cur = apprLastMsgId_(it.threadId);
    if (cur && cur !== it.basisMsgId && !edits.force) return { stale: true, message: 'Öneri hazırlandıktan sonra bu konuya yeni mesaj geldi.' };
    it.state = 'SENDING'; apprWrite_(it);
  } finally { lock.releaseLock(); }
  try {
    var text = String(edits.text != null ? edits.text : it.data.text || '').replace(/\s+$/, '');
    if (!text.trim()) throw new Error('Metin boş');
    var res = {};
    if (it.type === 'JIRA_COMMENT') {
      var key = String(edits.key || it.data.key || '').trim().toUpperCase();
      var men = {}, P = it.data.people || {};
      Object.keys(P).forEach(function (n) { if (text.indexOf('@' + n) >= 0) men[n] = P[n]; });
      var r = addJiraComment(key, text, men, it.data.atts || [], it.threadId);
      res = { key: r.key, url: r.url, card: r.card, effect: r.effect };
    } else {
      var to = edits.to || it.data.to || [], cc = edits.cc || it.data.cc || [];
      var s = sendReply(it.threadId, text, to, cc, 'send');
      var card = null; try { card = refreshAfterReply(it.threadId); } catch (e) {}
      res = { card: card || s.card, to: to, cc: cc };
    }
    it.state = 'DONE'; it.data.text = text; it.data.result = { at: new Date().toISOString() };
    if (edits.to) it.data.to = edits.to; if (edits.cc) it.data.cc = edits.cc;
    apprWrite_(it);
    log_('INFO', 'Onay verildi (' + it.type + '): ' + String(it.data.title || '').slice(0, 70) + ' [' + it.threadId + ']');
    res.ok = true;
    return res;
  } catch (e) {
    it.state = 'READY'; apprWrite_(it);     // gönderilemedi: öneri kuyrukta kalsın
    throw e;
  }
}

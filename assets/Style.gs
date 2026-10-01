/**
 * İsteğe bağlı YAZI AVATARI — kullanıcının kendi mail üslubu (talimat + birkaç gerçek "gelen → cevap" örneği).
 * Doluysa Gemini'nin yazdığı cevap taslakları (suggested_reply) bu üslupla yazılır.
 * Nasıl doldurulur: kullanıcının gönderilmiş maillerinden hitap/kapanış kuralları, ton, sık kalıplar ve
 * 10-15 kısa gerçek örnek çıkarılıp tek bir metin olarak buraya konur (~20 KB'ı geçmesin; her AI çağrısına eklenir).
 */
var WRITING_STYLE_ = '';

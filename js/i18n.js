/* Перевод сайта на английский (и обратно).

   КАК УСТРОЕНО. Сайт написан на русском. Английский словарь лежит в i18n/en.js
   (window.I18N_EN): русская фраза → английская. Когда выбран английский, этот файл
   проходит по странице и подменяет тексты:
     • «блоки» — абзац, пункт списка, заголовок, кнопка, подпись… целиком (с жирным,
       курсивом и переносами внутри), ключ — текст блока без лишних пробелов;
     • подсказки в полях, aria-label, title, alt;
     • то, что скрипты дописывают на страницу позже (окно входа, плашки, подсказки), —
       следит MutationObserver.
   Фразы с числами («Страница 12», «Желание 3») — шаблонами из I18N_EN.patterns.
   То, что пишет сам человек (поля ответов, надписи, желания, имя на обложке), не трогается.
   Фразы, которых нет в словаре, остаются по-русски — на русской версии ничего не меняется.

   ЯЗЫК хранится в kniga-goda:v1:lang ("ru" | "en") — сохраняется и в аккаунте.
   Смена языка — перезагрузка страницы на том же месте (js/settings.js → I18N.set).
   Словарь подключается ещё в <head> (index.html), поэтому английский виден сразу. */
(function () {
  "use strict";
  var KEY = "kniga-goda:v1:lang";
  var root = document.documentElement;
  function get() { try { return localStorage.getItem(KEY) === "en" ? "en" : "ru"; } catch (e) { return "ru"; } }
  var lang = get();
  var CYR = /[А-Яа-яЁё]/;
  var INLINE = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, SMALL: 1, SUP: 1, SUB: 1, MARK: 1, Q: 1, ABBR: 1, SPAN: 1, BR: 1, A: 1 };
  var SKIP = "script,style,textarea,input,select,[contenteditable],.lines,.rc-note,.wish-txt,.cover-measure,.word-box,[data-i18n-skip]";
  // внутри таких элементов блок целиком не заменяем (переводим по кусочкам): поля, кнопки, рисунки и элементы, которые держат скрипты ([id], .sync-code-email, .wish-dlg-n)
  var KEEP = "input,textarea,select,svg,img,video,audio,iframe,canvas,[contenteditable],button,dialog,form,[id],.sync-code-email,.wish-dlg-n";
  var ATTRS = ["placeholder", "aria-label", "title", "alt"];

  function norm(s) { return String(s).replace(/\s+/g, " ").trim(); }
  function dict() { return window.I18N_EN || { text: {}, patterns: [] }; }
  // перевод одной фразы: точное совпадение, потом шаблоны; null — перевода нет
  function tr(ru) {
    var k = norm(ru), d = dict();
    if (!k || !CYR.test(k)) return null;
    if (d.text && Object.prototype.hasOwnProperty.call(d.text, k)) return d.text[k];
    var ps = d.patterns || [];
    for (var i = 0; i < ps.length; i++) {
      var re = ps[i][0] instanceof RegExp ? ps[i][0] : (ps[i][0] = new RegExp(ps[i][0]));
      if (re.test(k)) return k.replace(re, ps[i][1]);
    }
    return null;
  }
  // для скриптов: I18N.t("русский текст") → английский (если выбран и есть), иначе как есть
  function t(ru) { if (lang !== "en") return ru; var r = tr(ru); return r == null ? ru : r.replace(/<[^>]+>/g, ""); }

  /* ---------- какой элемент переводить целиком ---------- */
  function unitOf(textNode) {
    var el = textNode.parentElement, u = el;
    // подымаемся через «простые» inline-теги без атрибутов: <b>, <i>, <br>, <span>…
    while (u && INLINE[u.tagName] && !u.attributes.length && u.parentElement && u.parentElement !== document.body) u = u.parentElement;
    if (u && u.querySelector && u.querySelector(KEEP)) {
      // внутри есть поле, кнопка или рисунок — заменять целиком нельзя; берём ближайший безопасный
      u = el;
      while (u && u.querySelector(KEEP)) u = null;
      if (!u) return null;
    }
    return u;
  }

  var busy = false;
  function translate(scope) {
    if (lang !== "en" || !scope) return;
    busy = true;
    try {
      var done = new Set(), loose = [];
      var w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (!CYR.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
          var p = n.parentElement;
          if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var n, list = [], units = [];
      while ((n = w.nextNode())) list.push(n);
      list.forEach(function (node) {
        var u = unitOf(node);
        if (!u) { loose.push(node); return; }
        if (!done.has(u)) { done.add(u); units.push(u); }
      });
      // сначала внешние блоки: абзац с <em class="u">Действие</em> внутри переводим целиком,
      // а не слово «Действие» отдельно (иначе абзац потом не узнать по ключу)
      units.forEach(function (u) {
        for (var p = u.parentElement; p; p = p.parentElement) if (done.has(p)) return;
        if (!u.isConnected) return;
        var en = tr(u.textContent);
        if (en != null) u.innerHTML = en;
        else loose.push.apply(loose, textNodesOf(u));           // блок целиком не нашёлся — пробуем по кусочкам
      });
      loose.forEach(function (node) {
        if (!node.isConnected || !CYR.test(node.nodeValue)) return;
        var en = tr(node.nodeValue);
        if (en != null) {
          var lead = node.nodeValue.match(/^\s*/)[0], tail = node.nodeValue.match(/\s*$/)[0];
          node.nodeValue = lead + en.replace(/<[^>]+>/g, "") + tail;
        }
      });
      // подсказки и подписи
      var els = scope.nodeType === 1 ? [scope].concat([].slice.call(scope.querySelectorAll("[placeholder],[aria-label],[title],[alt]"))) : [];
      els.forEach(function (el) {
        if (el.closest && el.closest("[data-i18n-skip]")) return;
        ATTRS.forEach(function (a) {
          var v = el.getAttribute && el.getAttribute(a);
          if (v && CYR.test(v)) { var en = tr(v); if (en != null) el.setAttribute(a, en.replace(/<[^>]+>/g, "")); }
        });
      });
    } finally { busy = false; }
  }
  function textNodesOf(el) {
    var out = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) if (CYR.test(n.nodeValue) && !n.parentElement.closest(SKIP)) out.push(n);
    return out;
  }

  /* ---------- смена языка ---------- */
  function set(next) {
    next = next === "en" ? "en" : "ru";
    if (next === lang) return;
    try { localStorage.setItem(KEY, next); } catch (e) {}
    try { sessionStorage.setItem("kg-lang-scroll", String(scrollY)); sessionStorage.setItem("kg-autoreload", "1"); } catch (e) {}
    location.reload();
  }

  window.I18N = {
    lang: function () { return lang; }, set: set, t: t, tr: tr, apply: translate,
    // для подготовки словаря: все русские фразы страницы (блоки и подписи)
    collect: function () {
      var saved = lang; lang = "en"; var out = [], seen = {};
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) { var p = n.parentElement; return CYR.test(n.nodeValue) && p && !p.closest(SKIP) ? 1 : 3; }
      }), n;
      var push = function (kind, el, key, html) {
        key = norm(key); if (!key || seen[key]) return; seen[key] = 1;
        var sh = el && el.closest && el.closest(".sheet, .intro, header, #syncModal, dialog");
        out.push({ where: sh ? (sh.id || sh.className.split(" ")[0]) : "", kind: kind, ru: key, html: html, has: tr(key) != null });
      };
      while ((n = w.nextNode())) {
        var u = unitOf(n);
        if (u) push("block", u, u.textContent, u.innerHTML.replace(/\s+/g, " ").trim()); else push("text", n.parentElement, n.nodeValue, "");
      }
      document.querySelectorAll("[placeholder],[aria-label],[title],[alt]").forEach(function (el) {
        ATTRS.forEach(function (a) { var v = el.getAttribute(a); if (v && CYR.test(v)) push("attr:" + a, el, v, ""); });
      });
      lang = saved;
      return out;
    }
  };

  // вернуться на то же место после смены языка (и на русский, и на английский)
  var restore = function () {
    try {
      var y = sessionStorage.getItem("kg-lang-scroll");
      if (y != null) { sessionStorage.removeItem("kg-lang-scroll"); scrollTo(0, Number(y)); }
    } catch (e) {}
  };
  if (lang !== "en") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", restore); else restore();
    return;
  }
  root.setAttribute("lang", "en");
  // заголовки-рисунки (векторные надписи из книги) — английские версии из i18n/en-art.js
  function art() {
    var A = window.I18N_EN_ART; if (!A) return;
    Object.keys(A).forEach(function (k) {
      var el = k === "cover" ? document.querySelector(".cover-title-art")
             : k === "final" ? document.querySelector("#p97 .final-svg")
             : document.querySelector("#" + k + " .title-art");
      if (!el) return;
      el.setAttribute("viewBox", A[k].vb);
      if (el.classList.contains("title-art")) el.style.setProperty("--h", A[k].h);
      el.innerHTML = A[k].svg;
    });
  }
  var start = function () {
    art();
    translate(document.body);
    if (document.title && tr(document.title)) document.title = tr(document.title).replace(/<[^>]+>/g, "");
    // то, что скрипты дописывают позже
    new MutationObserver(function (muts) {
      if (busy) return;
      muts.forEach(function (m) {
        if (m.type === "attributes") { translate(m.target); return; }
        if (m.type === "characterData") { var p = m.target.parentElement; if (p) translate(p); return; }
        m.addedNodes.forEach(function (x) { translate(x.nodeType === 1 ? x : x.parentElement); });
      });
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    restore();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();

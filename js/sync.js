/* Окно «Сохраните ваши записи»: регистрация и вход по ССЫЛКЕ из письма (Firebase Authentication).
   Экраны (data-view на #syncModal):
     login    — почта: есть в списке покупателей → письмо со ссылкой (подтверждает почту); нет → «купите доступ у автора».
                Пока человек не вошёл, книга закрыта этим окном
     register — «Последний шаг»: почта подтверждена, а имени и даты рождения ещё нет → ввести их → книга открыта
                (кто уже вводил их раньше, сразу попадает в книгу)
     code     — «Проверьте почту»: ссылка отправлена, можно отправить ещё раз или изменить почту
     confirm  — ссылку открыли на другом устройстве: ввести почту, чтобы завершить вход
     success  — «Готово, …!» → «Продолжить писать»
   Человек нажимает ссылку в письме → открывается сайт → вход завершается сам → экран success,
   книга подтягивается из Firestore (js/cloud.js).
   Окно открыто и не закрывается, пока человек не вошёл и его почта есть в списке покупателей.

   Firebase подключён в index.html (window.Firebase, событие "firebase:ready").
   В консоли Firebase должны быть включены: Authentication → Электронная почта/пароль → «Ссылка по
   электронной почте», а адрес сайта (kustovaannetta.github.io) — в «Авторизованных доменах».
   Ссылка работает только на опубликованном сайте (или localhost): при открытии файла с диска
   окно честно скажет, что вход недоступен. */
(function () {
  "use strict";
  var modal = document.getElementById("syncModal");
  if (!modal) return;
  var regForm = document.getElementById("syncForm");
  var loginForm = document.getElementById("syncLoginForm");
  var confirmForm = document.getElementById("syncConfirmForm");
  var hello = document.getElementById("syncHello");
  var successMsg = modal.querySelector(".sync-success__msg");
  var codeEmailEl = modal.querySelector(".sync-code-email");
  var linkError = modal.querySelector(".sync-link-error");
  var resendBtn = modal.querySelector("[data-sync-resend]");
  var resendTimer = modal.querySelector(".sync-resend-timer");
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var KEY = "kniga-goda:v1:syncUser";            // кто сейчас вошёл: { name, email, uid }
  var EMAIL_FOR_LINK = "kniga-goda:emailForSignIn";   // почта, на которую ушла ссылка (чтобы завершить вход без вопросов)
  var NAME_FOR_LINK = "kniga-goda:nameForSignIn";     // имя из регистрации — запишем в профиль после входа
  var lastFocus = null;
  var pending = null;            // { mode: "register"|"login", name, email }
  var cooldown = 0, cdTimer = 0;

  var BOOK_FIELDS = 'textarea, [contenteditable="true"], [contenteditable="plaintext-only"], ' +
    'input:not([type]), input[type="text"], input[type="number"], input[type="email"], input[type="tel"], input[type="search"]';

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function isRegistered() { return !!get(KEY); }

  /* ---------- Firebase: ждём, пока подключится (index.html) ---------- */
  var fbReady = new Promise(function (resolve) {
    if (window.Firebase) resolve(window.Firebase);
    else document.addEventListener("firebase:ready", function (e) { resolve(e.detail); }, { once: true });
  });
  function linkUrl() { return location.origin + location.pathname; }   // куда вернёт ссылка из письма — на эту же страницу

  /* ---------- список покупателей ----------
     Автор вносит почту покупателя в Google Таблицу → Apps Script кладёт её в Firestore:
       allowed/{почта маленькими буквами} = { registered: false }
     Регистрация: почта есть в списке + имя + дата рождения → письмо со ссылкой (подтверждает, что почта
     правда этого человека) → после входа: books/{uid} = { email, name, birth }, allowed/{почта}.registered = true.
     Вход: почта есть в списке и уже зарегистрирована → письмо со ссылкой → своя книга.
     Пока человек не вошёл и его почты нет в списке, книга закрыта окном без крестика.
     Правила Firestore пускают к записям только тех, чья почта есть в allowed: убрали почту из таблицы — доступ закрыт. */
  function emailId(e) { return String(e || "").trim().toLowerCase(); }
  // "none" — почты нет в списке; "new" — есть, но ещё не зарегистрирована; "registered"; "error" — не удалось узнать
  function lookup(email) {
    return fbReady.then(function (F) { return F.fb.getDoc(F.fb.doc(F.db, "allowed", emailId(email))); })
      .then(function (s) { return !s.exists() ? "none" : (s.data().registered ? "registered" : "new"); })
      .catch(function (err) { if (window.console) console.warn("Почта не проверилась:", err && (err.code || err)); return "error"; });
  }
  var NOT_LISTED = "Этой почты нет в списке покупателей. Чтобы открыть книгу, купите доступ у автора — @annetta_kustova";
  var CHECK_FAILED = "Не получилось проверить почту. Попробуйте ещё раз";
  var REG_FOR_LINK = "kniga-goda:regForSignIn";       // имя и дата рождения из регистрации — запишем после входа

  // после входа по ссылке из регистрации: записать имя и дату рождения и отметить почту зарегистрированной
  function saveRegistration(F, u, reg) {
    var b = F.fb.writeBatch(F.db);
    b.set(F.fb.doc(F.db, "books", u.uid), { email: u.email || "", name: reg.name, birth: reg.birth }, { merge: true });
    b.update(F.fb.doc(F.db, "allowed", emailId(u.email)), { registered: true, uid: u.uid, registeredAt: F.fb.serverTimestamp() });
    return b.commit();
  }

  /* Письмо со ссылкой для входа отправляет скрипт Google Таблицы (веб-приложение Apps Script):
     красивое письмо в стиле сайта, с почты автора, на языке сайта. Скрипт сам проверяет, что почта
     есть в списке покупателей, и берёт у Firebase саму ссылку. Пусто или скрипт не ответил —
     обычное письмо Firebase, чтобы вход не ломался. */
  var MAIL_URL = "";

  var Auth = {
    // отправить письмо со ссылкой для входа; reg = { name, birth } — при регистрации
    // (едет и в самой ссылке, чтобы регистрация завершилась, даже если письмо открыли на другом устройстве)
    sendLink: function (email, reg) {
      if (location.protocol === "file:") return Promise.reject({ code: "local-file" });
      var url = linkUrl() + (reg ? "?reg=1&n=" + encodeURIComponent(reg.name) + "&b=" + encodeURIComponent(reg.birth) : "");
      var viaFirebase = function () {
        return fbReady.then(function (F) { return F.fb.sendSignInLinkToEmail(F.auth, email, { url: url, handleCodeInApp: true }); });
      };
      var final = { "not-listed": 1, "too-many-requests": 1, "invalid-email": 1 };   // это ответ по делу — Firebase не поможет
      var job = MAIL_URL && !reg
        ? fetch(MAIL_URL, { method: "POST", body: JSON.stringify({ email: email, lang: window.I18N ? I18N.lang() : "ru" }) })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              if (res && res.ok) return;
              var code = { none: "not-listed", wait: "too-many-requests", invalid: "invalid-email" }[res && res.reason] || "mail-script";
              throw { code: code, message: res && res.message };
            })
            .catch(function (err) {
              if (err && final[err.code]) throw err;
              if (window.console) console.warn("Красивое письмо не отправилось, отправляем обычное:", err && (err.code || err.message || err), err && err.message);
              return viaFirebase();
            })
        : viaFirebase();
      return job.then(function () {
        set(EMAIL_FOR_LINK, email);
        set(REG_FOR_LINK, reg ? JSON.stringify(reg) : null);
      });
    },
    // завершить вход по ссылке из адресной строки (и регистрацию, если ссылка из регистрации)
    complete: function (email) {
      var q = new URLSearchParams(location.search), reg = null;
      if (q.get("reg") && q.get("n") && q.get("b")) reg = { name: q.get("n"), birth: q.get("b") };
      else try { reg = JSON.parse(get(REG_FOR_LINK) || "null"); } catch (e) {}
      return fbReady.then(function (F) {
        return F.fb.signInWithEmailLink(F.auth, email, location.href).then(function (cred) {
          var u = cred.user, name = (reg && reg.name) || u.displayName || "";
          var job = (name && name !== u.displayName) ? F.fb.updateProfile(u, { displayName: name }).catch(function () {}) : Promise.resolve();
          return job.then(function () {
            if (!reg) return;
            if (reg.birth) set("kniga-goda:v1:birth", reg.birth);
            return saveRegistration(F, u, reg).catch(function (err) { if (window.console) console.warn("Регистрация не записалась:", err && (err.code || err)); });
          }).then(function () {
            set(EMAIL_FOR_LINK, null); set(NAME_FOR_LINK, null); set(REG_FOR_LINK, null);
            history.replaceState(null, "", linkUrl() + location.hash);   // убрать служебные параметры ссылки из адреса
            return { name: name, email: u.email, uid: u.uid };
          });
        });
      });
    },
    // вошедший человек: можно ли к книге. "ok" | "new" (почта в списке, но не зарегистрирован) | "none" | null (нет сети)
    access: function () {
      return fbReady.then(function (F) {
        var u = F.auth.currentUser; if (!u) return "none";
        return lookup(u.email).then(function (st) { return st === "registered" ? "ok" : st === "error" ? null : st; });
      });
    },
    signOut: function () { return fbReady.then(function (F) { return F.fb.signOut(F.auth); }).catch(function () {}); }
  };

  function errorText(err) {
    var c = (err && err.code) || "";
    if (c === "not-listed") return NOT_LISTED;
    if (c === "local-file") return "Вход работает на опубликованном сайте. Откройте kustovaannetta.github.io/book-of-the-year и попробуйте там.";
    if (c.indexOf("invalid-email") >= 0) return "Похоже, в адресе почты опечатка.";
    if (c.indexOf("unauthorized-continue-uri") >= 0 || c.indexOf("unauthorized-domain") >= 0) return "Этот адрес сайта не добавлен в Firebase (Authentication → Настройки → Авторизованные домены).";
    if (c.indexOf("operation-not-allowed") >= 0) return "В Firebase не включён вход по ссылке (Authentication → Способ входа → Электронная почта → «Ссылка по электронной почте»).";
    if (c.indexOf("quota-exceeded") >= 0 || c.indexOf("too-many-requests") >= 0) return "Слишком много писем подряд. Попробуйте чуть позже.";
    if (c.indexOf("network") >= 0) return "Нет связи с интернетом. Проверьте подключение и попробуйте снова.";
    if (c.indexOf("invalid-action-code") >= 0 || c.indexOf("expired-action-code") >= 0) return "Ссылка устарела или уже использована. Запросите новую.";
    return "Не получилось отправить письмо. Попробуйте ещё раз.";
  }

  /* ---------- звёзды ---------- */
  (function makeStars() {
    var sky = modal.querySelector(".sync-modal__stars");
    var rnd = function (a, b) { return a + Math.random() * (b - a); };
    var frag = document.createDocumentFragment(), i, s, size;
    for (i = 0; i < 45; i++) {
      s = document.createElement("span"); size = rnd(1, 2.6);
      s.className = "star" + (Math.random() < 0.3 ? " star--gold" : "");
      s.style.cssText = "left:" + rnd(0, 100) + "%;top:" + rnd(0, 100) + "%;width:" + size + "px;height:" + size + "px;" +
        "--d:" + rnd(2, 5).toFixed(2) + "s;--delay:" + rnd(0, 5).toFixed(2) + "s";
      frag.appendChild(s);
    }
    for (i = 0; i < 6; i++) {
      s = document.createElement("span"); s.className = "sparkle"; s.innerHTML = "<i></i>";
      s.style.cssText = "left:" + rnd(4, 96) + "%;top:" + rnd(4, 96) + "%;--s:" + rnd(10, 22).toFixed(0) + "px;" +
        "--d:" + rnd(3, 6).toFixed(2) + "s;--delay:" + rnd(0, 6).toFixed(2) + "s";
      frag.appendChild(s);
    }
    sky.appendChild(frag);
  })();

  /* ---------- экраны ---------- */
  var wantView = "login";        // какой экран показать (открытие окна с задержкой не должно перебить более поздний выбор)
  function show(view) {
    wantView = view;
    modal.dataset.view = view;
    var first = { register: regForm.name, login: loginForm.email, confirm: confirmForm.email }[view];
    if (first) setTimeout(function () { first.focus(); }, 60);
  }
  // книга закрыта, пока человек не вошёл: окно без крестика, не закрывается по Esc и по клику мимо
  function lock() {
    modal.classList.toggle("is-locked", !isRegistered());
    document.documentElement.classList.toggle("kg-gate", !isRegistered());   // книга за окном видна только после входа
  }
  function open(target, view) {
    lastFocus = target || document.activeElement;
    lock();
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.documentElement.style.overflow = "hidden";
    wantView = view || "login";
    setTimeout(function () { show(wantView); }, 250);
  }
  function close() {
    if (!modal.classList.contains("is-open") || !isRegistered()) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.documentElement.style.overflow = "";
    // курсор возвращаем в поле только после входа — иначе окно открылось бы снова
    if (isRegistered() && lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }
  function busy(form, on) {
    var b = form.querySelector(".sync-btn");
    b.disabled = on; b.classList.toggle("is-loading", on);
  }
  function setError(form, name, isError, text) {
    var f = form.querySelector('[data-field="' + name + '"]');
    f.classList.toggle("is-invalid", isError);
    if (text) f.querySelector(".field__error").textContent = text;
  }

  /* ---------- отправка ссылки ---------- */
  function startCooldown() {
    cooldown = 60;
    resendBtn.disabled = true;
    clearInterval(cdTimer);
    var tick = function () {
      resendTimer.textContent = cooldown > 0 ? "через " + cooldown + " с" : "";
      if (cooldown <= 0) { clearInterval(cdTimer); resendBtn.disabled = false; }
      cooldown--;
    };
    tick(); cdTimer = setInterval(tick, 1000);
  }
  function sendLink(form) {
    busy(form, true);
    linkError.hidden = true;
    return Auth.sendLink(pending.email, pending.reg).then(function () {
      codeEmailEl.textContent = pending.email;
      startCooldown();
      show("code");
    }, function (err) {
      if (form === modal) { linkError.textContent = errorText(err); linkError.hidden = false; return; }
      setError(form, "email", true, errorText(err));
    }).finally(function () { if (form !== modal) busy(form, false); });
  }

  /* ---------- дата рождения: списки «день / месяц / год» ----------
     Сохраняется как "ГГГГ-ММ-ДД" в kniga-goda:v1:birth — уходит в аккаунт вместе с книгой
     (js/cloud.js) и пишется в карточку books/{uid} полем birth. */
  var BIRTH_KEY = "kniga-goda:v1:birth";
  var bD = regForm.querySelector(".birth__d"), bM = regForm.querySelector(".birth__m"), bY = regForm.querySelector(".birth__y");
  (function fillBirth() {
    var en = window.I18N && I18N.lang() === "en";
    var months = en ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
                    : ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
    var opt = function (sel, value, text) { var o = document.createElement("option"); o.value = value; o.textContent = text; sel.appendChild(o); };
    opt(bD, "", en ? "Day" : "День"); opt(bM, "", en ? "Month" : "Месяц"); opt(bY, "", en ? "Year" : "Год");
    for (var d = 1; d <= 31; d++) opt(bD, d, d);
    months.forEach(function (m, i) { opt(bM, i + 1, m); });
    for (var y = new Date().getFullYear() - 5; y >= 1930; y--) opt(bY, y, y);
    [bD, bM, bY].forEach(function (s) { s.options[0].disabled = true; s.selectedIndex = 0; });
    if (en) { bD.parentNode.insertBefore(bM, bD); bD.parentNode.classList.add("birth--mdy"); }   // по-английски привычнее «Month Day Year»
  })();
  // в коротких месяцах лишние дни недоступны (30 февраля и т. п.)
  function fixDays() {
    var y = Number(bY.value) || 2000, m = Number(bM.value);
    var max = m ? new Date(y, m, 0).getDate() : 31;
    for (var i = 1; i < bD.options.length; i++) bD.options[i].disabled = Number(bD.options[i].value) > max;
    if (Number(bD.value) > max) bD.selectedIndex = 0;
  }
  bM.addEventListener("change", fixDays); bY.addEventListener("change", fixDays);
  [bD, bM, bY].forEach(function (s) { s.addEventListener("change", function () { s.classList.toggle("is-set", !!s.value); }); });
  function birthValue() {
    if (!bD.value || !bM.value || !bY.value) return "";
    var p = function (n) { return (n < 10 ? "0" : "") + Number(n); };
    return bY.value + "-" + p(bM.value) + "-" + p(bD.value);
  }

  // «Последний шаг»: почта уже подтверждена ссылкой, имени и даты рождения ещё нет — записать и открыть книгу
  regForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = regForm.name.value.trim(), birth = birthValue();
    var okN = name.length >= 2, okB = !!birth;
    setError(regForm, "name", !okN, "Пожалуйста, введите имя"); setError(regForm, "birth", !okB);
    if (!okN || !okB) return;
    busy(regForm, true);
    fbReady.then(function (F) {
      var u = F.auth.currentUser;
      if (!u) { show("login"); return; }                 // вход потерялся — начать заново
      return saveRegistration(F, u, { name: name, birth: birth }).then(function () {
        set(BIRTH_KEY, birth);
        return F.fb.updateProfile(u, { displayName: name }).catch(function () {});
      }).then(function () {
        signedIn({ name: name, email: u.email, uid: u.uid }, true);
        show("success");
      }, function (err) {
        if (window.console) console.warn("Имя и дата не сохранились:", err && (err.code || err));
        setError(regForm, "name", true, "Не получилось сохранить. Попробуйте ещё раз");
      });
    }).finally(function () { busy(regForm, false); });
  });
  // вход: почта есть в списке покупателей → письмо со ссылкой; нет → «купите доступ у автора»
  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = loginForm.email.value.trim(), ok = EMAIL_RE.test(email);
    setError(loginForm, "email", !ok, "Проверьте почту — похоже, в адресе опечатка");
    if (!ok) return;
    busy(loginForm, true);
    lookup(email).then(function (st) {
      if (st === "registered" || st === "new") { pending = { mode: "login", name: "", email: email, reg: null }; sendLink(loginForm); return; }
      busy(loginForm, false);
      setError(loginForm, "email", true, st === "none" ? NOT_LISTED : CHECK_FAILED);
    });
  });
  resendBtn.addEventListener("click", function () {
    if (!pending || resendBtn.disabled) return;
    Auth.sendLink(pending.email, pending.reg).then(function () { linkError.hidden = true; startCooldown(); },
      function (err) { linkError.textContent = errorText(err); linkError.hidden = false; });
  });

  /* ---------- вход завершён ---------- */
  function signedIn(user, fresh) {
    set(KEY, JSON.stringify(user));
    lock();
    hello.textContent = user.name || "друг";
    successMsg.textContent = fresh
      ? "Вы вошли в свою книгу. Записи сохраняются в вашем аккаунте — их можно открыть на любом устройстве."
      : "Вы вошли в свою книгу. Можно продолжать писать.";
    document.dispatchEvent(new CustomEvent("sync:success", { detail: user }));
  }

  // человек пришёл по ссылке из письма
  function finish(email, form) {
    if (form) busy(form, true);
    return Auth.complete(email).then(function (user) {
      return Auth.access().then(function (st) {
        var view = "success";
        if (st === "ok" || st === null) signedIn(user, true);
        else if (st === "new") { if (user.name) regForm.name.value = user.name; view = "register"; }   // имени и даты ещё нет — спросить
        else {                                   // почты нет в списке покупателей
          Auth.signOut(); view = "login"; loginForm.email.value = user.email || "";
          setTimeout(function () { setError(loginForm, "email", true, NOT_LISTED); }, 300);
        }
        if (modal.classList.contains("is-open")) show(view); else open(null, view);
      });
    }, function (err) {
      if (form) { setError(form, "email", true, errorText(err)); return; }
      open(null, "login");
      setTimeout(function () { setError(loginForm, "email", true, errorText(err)); }, 300);
    }).finally(function () { if (form) busy(form, false); });
  }
  confirmForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = confirmForm.email.value.trim(), ok = EMAIL_RE.test(email);
    setError(confirmForm, "email", !ok, "Проверьте почту — похоже, в адресе опечатка");
    if (ok) finish(email, confirmForm);
  });

  fbReady.then(function (F) {
    if (F.fb.isSignInWithEmailLink(F.auth, location.href)) {
      var email = get(EMAIL_FOR_LINK);
      if (email) finish(email); else open(null, "confirm");
      return;
    }
    // уже вошёл раньше (Firebase помнит вход) — или вышел в другом месте
    F.fb.onAuthStateChanged(F.auth, function (u) {
      var saved = null; try { saved = JSON.parse(get(KEY) || "null"); } catch (e) {}
      if (!u) { if (saved) { set(KEY, null); gate(); } return; }   // вход больше не действует — книга закрывается
      // вход есть — почта всё ещё в списке покупателей? (нет сети — ничего не меняем)
      Auth.access().then(function (st) {
        if (st === null) return;
        if (st === "ok") {
          if (!saved || saved.uid !== u.uid) signedIn({ name: u.displayName || "", email: u.email, uid: u.uid }, false);
          if (modal.dataset.view === "login") close();
        } else if (st === "new") {              // почта подтверждена, но имя и дату так и не ввели — спросить сейчас
          set(KEY, null); if (u.displayName) regForm.name.value = u.displayName;
          gate("register");
        } else { set(KEY, null); Auth.signOut(); gate(); }   // автор убрал почту из таблицы — книга снова закрыта
      });
    });
  });
  // закрыть книгу: показать окно входа (или «Последний шаг»)
  function gate(view) {
    if (isRegistered()) return;
    if (modal.classList.contains("is-open")) { lock(); if (view) show(view); } else open(null, view || "login");
  }
  gate();
  // пришёл по кнопке из письма-приглашения (?email=…) — почта в окне входа уже вписана
  (function prefill() {
    var q = new URLSearchParams(location.search), em = q.get("email");
    if (!em || q.get("oobCode")) return;
    loginForm.email.value = em;
    q.delete("email");
    history.replaceState(null, "", linkUrl() + (q.toString() ? "?" + q.toString() : "") + location.hash);
  })();

  /* ---------- переходы, закрытие, клавиатура ---------- */
  modal.addEventListener("click", function (e) {
    var go = e.target.closest("[data-sync-go]");
    if (go) {
      show(go.dataset.syncGo);
    }
    if (e.target.closest("[data-sync-back]")) show("login");
    if (e.target.closest("[data-sync-close]")) close();
    if (e.target.closest("[data-sync-other]")) {    // «Войти заново» с другой почтой
      set(KEY, null); Auth.signOut(); show("login");
    }
  });
  [regForm, loginForm, confirmForm].forEach(function (f) {
    f.addEventListener("input", function (e) { var x = e.target.closest(".field"); if (x) x.classList.remove("is-invalid"); });
  });
  document.addEventListener("keydown", function (e) {
    if (!modal.classList.contains("is-open")) return;
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      var items = [].slice.call(modal.querySelectorAll("button, input, select")).filter(function (el) { return el.offsetParent && !el.disabled; });
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  /* ---------- показ окна: человек ставит курсор в поле для текста или числа ---------- */
  document.addEventListener("focusin", function (e) {
    var el = e.target;
    if (modal.contains(el) || !el.matches || !el.matches(BOOK_FIELDS)) return;
    if (el.closest("dialog")) return;          // поля во всплывающих окнах сайта (желание на Древе)
    if (isRegistered() || modal.classList.contains("is-open")) return;   // показываем при каждом нажатии, пока человек не вошёл
    el.blur();
    open(el);
  });

  window.SyncModal = {
    open: function (view) { open(null, view); }, close: close, Auth: Auth,
    // выйти из аккаунта: ответы в этом браузере остаются
    reset: function () {
      set(KEY, null);
      Auth.signOut();
      [regForm, loginForm, confirmForm].forEach(function (f) { f.reset(); });
      [bD, bM, bY].forEach(function (s) { s.selectedIndex = 0; s.classList.remove("is-set"); });
      pending = null;
    }
  };
})();

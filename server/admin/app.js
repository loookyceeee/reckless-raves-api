(function () {
  'use strict';
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  var app = document.getElementById('app');

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      var v = attrs[key];
      if (v === null || v === undefined || v === false) return;
      if (key === 'text') el.textContent = v;
      else if (key === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else if (key === 'cls') el.className = v;
      else if (v === true) el.setAttribute(key, '');
      else el.setAttribute(key, v);
    });
    (kids || []).forEach(function (kid) { if (kid) el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid); });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function up(s) { return String(s == null ? '' : s).toUpperCase(); }
  function when(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase() + ' UK';
    } catch (e) { return iso; }
  }
  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-CSRF-Token'] = csrf;
      opts.body = JSON.stringify(body);
    }
    return fetch('/admin/api' + path, opts).then(function (r) {
      if (r.status === 401) { location.href = '/admin/login'; throw new Error('SIGNED OUT'); }
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (j) { j._status = r.status; return j; });
    });
  }
  function msg(el, text, isErr) {
    clear(el);
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'msg' + (isErr ? ' err' : '');
    el.textContent = up(text);
  }
  function card(n, label, wide) {
    return h('div', { cls: 'card' + (wide ? ' wide' : '') }, [h('div', { cls: 'n', text: String(n) }), h('div', { cls: 'l', text: label })]);
  }

  /* ---------- NOTIFY ---------- */
  var draft = { title: '', body: '', path: '', email: 'loookyceeee@gmail.com' };
  function notify() {
    clear(app);
    var status = h('p', { hidden: true });
    var title = h('input', { id: 'nt', maxlength: '60', placeholder: 'ONE WEEK UNTIL GEARBOX.', value: draft.title, autocomplete: 'off' });
    var body = h('textarea', { id: 'nb', maxlength: '180', placeholder: 'MESSAGE', autocomplete: 'off' });
    body.value = draft.body;
    var tc = h('span', { cls: 'count' });
    var bc = h('span', { cls: 'count' });
    var select = h('select', { id: 'np' });
    var pv = { t: h('div', { cls: 't' }), b: h('div', { cls: 'b' }), p: h('div', { cls: 'p' }) };
    var preview = h('div', { cls: 'preview' }, [h('div', { cls: 'app', text: 'RECKLESS RAVES · NOW' }), pv.t, pv.b, pv.p]);
    var checkBtn = h('button', { cls: 'btn', type: 'button', text: '[ CHECK ]' });
    var sendBtn = h('button', { cls: 'btn primary', type: 'button', hidden: true });
    var confirmBox = h('div', { cls: 'confirm', hidden: true });
    var testEmail = h('input', { type: 'email', value: draft.email, autocomplete: 'off', autocapitalize: 'none' });
    var testBtn = h('button', { cls: 'btn', type: 'button', text: '[ TEST TO MY PHONE ]' });
    var history = h('ul', { cls: 'list' });
    var checked = null;

    function refresh() {
      draft.title = title.value; draft.body = body.value; draft.path = select.value; draft.email = testEmail.value;
      tc.textContent = title.value.length + '/60';
      bc.textContent = body.value.length + '/180';
      pv.t.textContent = up(title.value.trim()) || 'TITLE';
      pv.b.textContent = up(body.value.trim()) || 'MESSAGE';
      pv.p.textContent = 'TAP OPENS: ' + (select.value ? (select.options[select.selectedIndex] || {}).text : 'THE APP');
      checked = null; sendBtn.hidden = true; confirmBox.hidden = true;
    }
    [title, body, select, testEmail].forEach(function (el) { el.addEventListener('input', refresh); el.addEventListener('change', refresh); });

    function payload(extra) {
      var p = { title: title.value, body: body.value, path: select.value };
      Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
      return p;
    }
    checkBtn.addEventListener('click', function () {
      if (!title.value.trim() || !body.value.trim()) return msg(status, 'ADD A TITLE AND A MESSAGE', true);
      checkBtn.disabled = true;
      api('POST', '/push/check', {}).then(function (j) {
        checkBtn.disabled = false;
        if (!j.ok) return msg(status, j.message || j.error, true);
        checked = j.count;
        msg(status, 'WILL REACH ' + j.count + ' PHONES.' + (j.live ? '' : ' PUSH_LIVE IS OFF: A SEND WILL BE A DRY RUN.'), !j.live);
        sendBtn.textContent = '[ SEND TO ' + j.count + ' PHONES ]';
        sendBtn.hidden = j.count < 1;
      }).catch(function (e) { checkBtn.disabled = false; msg(status, e.message, true); });
    });
    sendBtn.addEventListener('click', function () {
      clear(confirmBox);
      confirmBox.hidden = false;
      var yes = h('button', { cls: 'btn primary', type: 'button', text: '[ YES, SEND NOW ]' });
      var no = h('button', { cls: 'btn', type: 'button', text: '[ CANCEL ]' });
      confirmBox.appendChild(h('p', { text: 'SEND "' + up(title.value.trim()) + '" TO ' + checked + ' PHONES? THIS CANNOT BE UNDONE.' }));
      confirmBox.appendChild(yes); confirmBox.appendChild(h('div', { cls: 'gap' })); confirmBox.appendChild(no);
      no.addEventListener('click', function () { confirmBox.hidden = true; });
      yes.addEventListener('click', function () {
        yes.disabled = true; no.disabled = true;
        api('POST', '/push/send', payload({ expect: checked })).then(function (j) {
          confirmBox.hidden = true; sendBtn.hidden = true; checked = null;
          if (!j.ok) return msg(status, j.message || j.error, true);
          msg(status, (j.dryRun ? 'DRY RUN ONLY (PUSH_LIVE OFF): ' : 'SENT: ') + j.sent + '/' + j.count + (j.errors.length ? ' · ' + j.errors.length + ' ERRORS' : ''), j.errors.length > 0);
          loadHistory();
        }).catch(function (e) { msg(status, e.message, true); });
      });
    });
    testBtn.addEventListener('click', function () {
      if (!title.value.trim() || !body.value.trim()) return msg(status, 'ADD A TITLE AND A MESSAGE', true);
      testBtn.disabled = true;
      api('POST', '/push/test', payload({ email: testEmail.value })).then(function (j) {
        testBtn.disabled = false;
        if (!j.ok) return msg(status, j.message || j.error, true);
        msg(status, 'TEST ' + (j.dryRun ? 'DRY RUN' : 'SENT') + ' TO ' + j.sent + '/' + j.count + ' PHONE(S)' + (j.errors.length ? ' · ERRORS: ' + j.errors.join(', ') : ''), j.errors.length > 0);
        loadHistory();
      }).catch(function (e) { testBtn.disabled = false; msg(status, e.message, true); });
    });
    function loadHistory() {
      api('GET', '/push/history').then(function (j) {
        clear(history);
        if (!j.ok || !j.history.length) return history.appendChild(h('li', { cls: 'meta', text: 'NOTHING SENT FROM HERE YET' }));
        j.history.forEach(function (row) {
          history.appendChild(h('li', {}, [
            h('div', { text: row.title }), h('div', { text: row.body }),
            h('div', { cls: 'meta', text: when(row.at) + ' · ' + (row.kind === 'test' ? 'TEST' : 'ALL') + ' · ' + (row.dryRun ? 'DRY RUN ' : 'SENT ') + row.sent + '/' + row.count + (row.path ? ' · ' + row.path : '') + (row.errors && row.errors.length ? ' · ERRORS ' + row.errors.length : '') }),
          ]));
        });
      });
    }

    app.appendChild(h('h2', { text: 'NOTIFICATIONS' }));
    app.appendChild(status);
    app.appendChild(h('div', { cls: 'stack' }, [
      h('div', { cls: 'row' }, [h('label', { 'for': 'nt', text: 'TITLE' }), tc]), title,
      h('div', { cls: 'row' }, [h('label', { 'for': 'nb', text: 'MESSAGE' }), bc]), body,
      h('label', { 'for': 'np', text: 'TAP OPENS' }), select,
      h('label', { text: 'PREVIEW' }), preview,
      checkBtn, sendBtn, confirmBox,
      h('h3', { text: 'TEST FIRST' }), testEmail, testBtn,
      h('p', { cls: 'hint', text: 'SENDS ONLY TO PHONES SIGNED IN WITH THIS EMAIL (MAX 3).' }),
    ]));
    app.appendChild(h('h3', { text: 'SENT HISTORY' }));
    app.appendChild(history);
    api('GET', '/push/targets').then(function (j) {
      (j.targets || []).forEach(function (t) { select.appendChild(h('option', { value: t.path, text: t.label })); });
      select.value = draft.path;
      refresh();
    });
    refresh();
    loadHistory();
  }

  /* ---------- CREW ---------- */
  var lastEmail = '';
  function crew() {
    clear(app);
    var status = h('p', { hidden: true });
    var input = h('input', { type: 'email', placeholder: 'FAN@EMAIL.COM', value: lastEmail, autocomplete: 'off', autocapitalize: 'none' });
    var go = h('button', { cls: 'btn primary', type: 'submit', text: '[ SEARCH ]' });
    var out = h('div');
    var form = h('form', { cls: 'stack' }, [h('label', { text: 'EMAIL' }), input, go]);
    form.addEventListener('submit', function (e) { e.preventDefault(); lookup(); });
    function lookup() {
      lastEmail = input.value.trim();
      if (!lastEmail) return;
      msg(status, '');
      clear(out);
      api('GET', '/crew?email=' + encodeURIComponent(lastEmail)).then(function (j) {
        if (!j.ok) return msg(status, j.message || j.error, true);
        if (!j.found) return msg(status, 'NO CREW ACCOUNT FOR ' + j.email, true);
        render(j);
      });
    }
    function action(name, label, danger, extra) {
      var btn = h('button', { cls: 'btn' + (danger ? ' danger' : ''), type: 'button', text: label });
      var box = h('div', { cls: 'confirm', hidden: true });
      btn.addEventListener('click', function () {
        clear(box); box.hidden = false;
        var typed = null;
        if (name === 'delete') {
          box.appendChild(h('p', { text: 'DELETES THE ACCOUNT, OUTFIT, PIN AND PHONES. PURCHASE XP IN THE SHEET STAYS. TYPE THE EMAIL TO CONFIRM.' }));
          typed = h('input', { type: 'email', autocomplete: 'off', autocapitalize: 'none' });
          box.appendChild(typed); box.appendChild(h('div', { cls: 'gap' }));
        } else {
          box.appendChild(h('p', { text: extra }));
        }
        var yes = h('button', { cls: 'btn primary', type: 'button', text: '[ CONFIRM ]' });
        var no = h('button', { cls: 'btn', type: 'button', text: '[ CANCEL ]' });
        box.appendChild(yes); box.appendChild(h('div', { cls: 'gap' })); box.appendChild(no);
        no.addEventListener('click', function () { box.hidden = true; });
        yes.addEventListener('click', function () {
          yes.disabled = true;
          api('POST', '/crew/action', { email: lastEmail, action: name, confirm: typed ? typed.value : undefined }).then(function (j) {
            yes.disabled = false;
            if (!j.ok) return msg(status, j.message || j.error, true);
            box.hidden = true;
            if (name === 'delete') { clear(out); return msg(status, 'ACCOUNT DELETED' + (j.ledgerKept ? ' (PURCHASE XP KEPT IN THE SHEET)' : ''), false); }
            msg(status, name === 'unlock-pin' ? 'PIN UNLOCKED' : 'PIN REMOVED. THEY CAN SET A NEW ONE.', false);
            lookup();
          });
        });
      });
      return h('div', {}, [btn, box, h('div', { cls: 'gap' })]);
    }
    function render(j) {
      var rows = [
        ['EMAIL', j.email], ['XP', j.xp], ['LEVEL', j.level], ['CREW', j.crew || '—'],
        ['AVATAR', j.avatarBase ? up(j.avatarBase) + (j.avatarBaseChosen ? '' : ' (DEFAULT)') : 'NOT PICKED'],
        ['PIN', j.pin.set ? 'SET' + (j.pin.setAt ? ' ' + when(j.pin.setAt) : '') : 'NOT SET'],
        ['PIN LOCK', j.pin.locked ? 'LOCKED (' + j.pin.lockedMinutes + ' MIN LEFT)' : 'OK' + (j.pin.wrongTries ? ' · ' + j.pin.wrongTries + ' WRONG TRIES' : '')],
        ['CODES', j.codes.length ? j.codes.map(function (c) { return c.code + ' · ' + up(c.crew) + (c.percent != null ? ' ' + c.percent + '%' : ''); }).join('\n') : 'NONE'],
        ['OWNED MERCH', j.owned.length ? j.owned.join(', ') : 'NONE'],
        ['PHONES', j.devices], ['DAY 1 CREW', j.day1 ? 'YES' : 'NO'],
        ['GAME', j.game.total + ' EVENTS · ' + j.game.countedToday + ' COUNTED TODAY'],
        ['ACCOUNT', j.hasAccount ? 'YES' : 'NO (LEDGER ONLY)'],
      ];
      var dl = h('dl', { cls: 'kv' });
      rows.forEach(function (r) { dl.appendChild(h('dt', { text: r[0] })); dl.appendChild(h('dd', { text: String(r[1]) })); });
      out.appendChild(h('h3', { text: 'CREW MEMBER' }));
      out.appendChild(dl);
      out.appendChild(h('h3', { text: 'ACTIONS' }));
      if (j.hasAccount) {
        out.appendChild(action('unlock-pin', '[ UNLOCK PIN ]', false, 'CLEAR THE WRONG-PIN LOCK FOR ' + j.email + '?'));
        out.appendChild(action('reset-pin', '[ RESET PIN ]', false, 'REMOVE THE PIN FOR ' + j.email + '? THEY SET A NEW ONE NEXT TIME.'));
      }
      out.appendChild(action('delete', '[ DELETE ACCOUNT ]', true));
    }
    app.appendChild(h('h2', { text: 'CREW LOOKUP' }));
    app.appendChild(status);
    app.appendChild(form);
    app.appendChild(out);
    if (lastEmail) lookup();
  }

  /* ---------- STATS ---------- */
  function stats() {
    clear(app);
    app.appendChild(h('h2', { text: 'STATS' }));
    var box = h('div', { text: 'LOADING…' });
    app.appendChild(box);
    api('GET', '/stats').then(function (j) {
      clear(box);
      if (!j.ok) return msg(box, j.error, true);
      var ios = j.downloads.ios;
      var dl = h('div', { cls: 'card wide' });
      dl.appendChild(h('div', { cls: 'l', text: 'DOWNLOADS · IOS APP STORE' }));
      if (ios.configured && !ios.error) {
        dl.appendChild(h('div', { cls: 'n', text: String(ios.total) }));
        dl.appendChild(h('div', { cls: 'l', text: 'SINCE LAUNCH · LAST 7 DAYS ' + ios.last7 + ' · YESTERDAY ' + (ios.yesterday == null ? 'NOT IN YET' : ios.yesterday) }));
        dl.appendChild(h('p', { cls: 'hint', text: 'FIRST-TIME DOWNLOADS FROM APPLE. DATA IS ~1 DAY BEHIND.' + (ios.latestReportDay ? ' LATEST DAY: ' + ios.latestReportDay + '.' : '') + ' UPDATES ' + ios.updatesTotal + ' · RE-DOWNLOADS ' + ios.redownloadsTotal }));
      } else {
        dl.appendChild(h('div', { cls: 'n', text: '—' }));
        var why = { NO_KEY: 'APPLE KEY NOT SET ON THE SERVER', NO_VENDOR: 'NEEDS THE APPLE VENDOR NUMBER', FORBIDDEN_NEEDS_SALES_ROLE: 'APPLE KEY NEEDS THE SALES ROLE', UNAUTHORIZED: 'APPLE KEY REFUSED' }[ios.error] || ('APPLE: ' + (ios.error || 'NOT LOADED YET'));
        dl.appendChild(h('p', { cls: 'hint', text: why + (ios.total ? ' · LAST KNOWN ' + ios.total : '') }));
      }
      var android = h('div', { cls: 'card wide' }, [
        h('div', { cls: 'l', text: 'DOWNLOADS · ANDROID' }),
        h('div', { cls: 'n', text: 'CONNECT PLAY REPORTING' }),
        h('p', { cls: 'hint', text: 'AT LEAST ' + j.downloads.android.devices + ' ANDROID PHONES (DEVICES WITH NOTIFICATIONS ON, NOT A DOWNLOAD COUNT).' }),
      ]);
      var d = j.devices;
      box.appendChild(h('div', { cls: 'grid' }, [
        dl, android,
        card(j.crewAccounts, 'CREW ACCOUNTS'), card(j.withPin, 'ACCOUNTS WITH A PIN'),
        card(d.total, 'PHONES WITH NOTIFICATIONS'), card(d.signedIn, 'OF THEM SIGNED IN'),
        card(d.ios, 'IPHONES'), card(d.android, 'ANDROID'),
        card(j.gameToday.counted, 'GAME EVENTS COUNTED TODAY'), card(j.gameToday.recorded, 'GAME EVENTS RECORDED TODAY'),
        card(j.pinLocked, 'PINS LOCKED NOW'), card(d.unknown, 'PHONES, PLATFORM UNKNOWN'),
      ]));
      box.appendChild(h('h3', { text: 'SWITCHES (READ ONLY)' }));
      Object.keys(j.flags).forEach(function (k) {
        var v = j.flags[k];
        box.appendChild(h('div', { cls: 'flag' }, [h('span', { text: k }), h('strong', { text: k === 'CREW_RESET_ID' ? (v ? 'SET' : 'NOT SET') : (v ? 'ON' : 'OFF') })]));
      });
      box.appendChild(h('p', { cls: 'hint', text: 'SWITCHES CHANGE ONLY ON YOUR GO, THROUGH THE BOT.' }));
    });
  }

  /* ---------- GAME EVENTS ---------- */
  function events() {
    clear(app);
    app.appendChild(h('h2', { text: 'GAME EVENTS' }));
    app.appendChild(h('a', { cls: 'btn', href: '/admin/api/events.csv', text: '[ DOWNLOAD CSV ]', download: 'game-events.csv' }));
    var list = h('ul', { cls: 'list' });
    app.appendChild(h('h3', { text: 'LATEST 50' }));
    app.appendChild(list);
    api('GET', '/events').then(function (j) {
      if (!j.ok || !j.events.length) return list.appendChild(h('li', { cls: 'meta', text: 'NO GAME EVENTS YET' }));
      j.events.forEach(function (e) {
        var type = e.type === 'digital_rave_attended' ? 'RAVE' : e.type === 'poster_placed' ? 'POSTER' : up(e.type);
        list.appendChild(h('li', {}, [
          h('div', { text: type + ' · ' + (e.counted ? 'COUNTED' : 'NOT COUNTED' + (e.reason ? ' (' + e.reason + ')' : '')) + (e.test ? ' · TEST' : '') }),
          h('div', { cls: 'meta', text: when(e.at) + ' · ' + e.email.toLowerCase() }),
        ]));
      });
    });
  }

  /* ---------- LOG ---------- */
  function log() {
    clear(app);
    app.appendChild(h('h2', { text: 'ADMIN LOG' }));
    var list = h('ul', { cls: 'list' });
    app.appendChild(list);
    api('GET', '/audit').then(function (j) {
      if (!j.ok || !j.audit.length) return list.appendChild(h('li', { cls: 'meta', text: 'NOTHING YET' }));
      j.audit.forEach(function (row) {
        var extra = [];
        ['email', 'target', 'title', 'count', 'sent', 'reason', 'route'].forEach(function (k) { if (row[k] !== undefined && row[k] !== null) extra.push(k.toUpperCase() + ' ' + row[k]); });
        if (row.dryRun) extra.push('DRY RUN');
        list.appendChild(h('li', {}, [h('div', { text: up(row.action).replace(/_/g, ' ') }), h('div', { cls: 'meta', text: when(row.at) + (extra.length ? ' · ' + extra.join(' · ') : '') })]));
      });
    });
  }

  var views = { notify: notify, crew: crew, stats: stats, events: events, log: log };
  var tabs = document.getElementById('tabs');
  tabs.addEventListener('click', function (e) {
    var tab = e.target.getAttribute && e.target.getAttribute('data-tab');
    if (!tab) return;
    Array.prototype.forEach.call(tabs.children, function (b) { b.classList.toggle('on', b === e.target); });
    views[tab]();
  });
  notify();
})();

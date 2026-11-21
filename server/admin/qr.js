/* RECKLESS admin: check-in QR poster (PNG + print) and the door screen. */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var W = 2480; // A4 at 300 dpi
  var H = 3508;

  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([
      document.fonts.load('900 100px Unbounded'),
      document.fonts.load('600 40px "DM Sans"'),
      document.fonts.load('400 40px "DM Sans"'),
    ]).catch(function () {});
  }
  function when(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase().replace(',', '');
  }
  function windowLine(q) {
    return q.opens ? 'CHECK-IN OPENS ' + when(q.opens) + ' · CLOSES ' + when(q.closes) + ' UK' : '';
  }

  /** <svg> of the QR (black modules on white, 4-module quiet zone). */
  function svg(q, px) {
    var pad = 4;
    var n = q.size + pad * 2;
    var el = document.createElementNS(NS, 'svg');
    el.setAttribute('viewBox', '0 0 ' + n + ' ' + n);
    el.setAttribute('width', px);
    el.setAttribute('height', px);
    el.setAttribute('shape-rendering', 'crispEdges');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Check-in QR code');
    var bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', n);
    bg.setAttribute('height', n);
    bg.setAttribute('fill', '#fff');
    el.appendChild(bg);
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', q.path);
    path.setAttribute('fill', '#000');
    path.setAttribute('transform', 'translate(' + pad + ' ' + pad + ')');
    el.appendChild(path);
    return el;
  }

  function fitText(ctx, text, font, size, maxWidth) {
    var s = size;
    ctx.font = font.replace('{s}', s);
    while (ctx.measureText(text).width > maxWidth && s > 20) {
      s -= 4;
      ctx.font = font.replace('{s}', s);
    }
    return s;
  }
  function spaced(ctx, text, x, y, spacing) {
    // centred text with letter spacing
    var chars = String(text).split('');
    var total = 0;
    chars.forEach(function (c) { total += ctx.measureText(c).width + spacing; });
    total -= spacing;
    var cx = x - total / 2;
    chars.forEach(function (c) {
      ctx.fillText(c, cx + ctx.measureText(c).width / 2, y);
      cx += ctx.measureText(c).width + spacing;
    });
  }

  /** Draws the A4 poster onto a canvas (2480 x 3508). */
  function drawPoster(canvas, q) {
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    var M = 180;
    ctx.font = '600 64px "DM Sans", Arial, sans-serif';
    spaced(ctx, 'RECKLESS RAVES · CHECK IN', W / 2, 300, 14);
    if (q.dateBadge) {
      ctx.font = '900 300px Unbounded, "Arial Black", sans-serif';
      ctx.fillText(q.dateBadge, W / 2, 640);
    }
    ctx.fillRect(W / 2 - 90, 720, 180, 10);
    var ts = fitText(ctx, q.title, '900 {s}px Unbounded, "Arial Black", sans-serif', 150, W - M * 2);
    ctx.fillText(q.title, W / 2, 900);
    if (q.subtitle) {
      fitText(ctx, q.subtitle, '900 {s}px Unbounded, "Arial Black", sans-serif', Math.min(ts, 120), W - M * 2);
      ctx.fillText(q.subtitle, W / 2, 900 + Math.min(ts, 120) + 40);
    }
    // QR in a white square
    var box = 1400;
    var top = 1200;
    var x0 = (W - box) / 2;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x0, top, box, box);
    var pad = 4;
    var n = q.size + pad * 2;
    var cell = box / n;
    ctx.fillStyle = '#000';
    var p = new Path2D(q.path);
    ctx.save();
    ctx.translate(x0 + pad * cell, top + pad * cell);
    ctx.scale(cell, cell);
    ctx.fill(p);
    ctx.restore();
    ctx.fillStyle = '#fff';
    var y = top + box + 190;
    fitText(ctx, 'SCAN IN THE RECKLESS APP', '900 {s}px Unbounded, "Arial Black", sans-serif', 104, W - M * 2);
    ctx.fillText('SCAN IN THE RECKLESS APP', W / 2, y);
    fitText(ctx, 'TO CHECK IN · +' + (q.xp || 50) + ' XP', '900 {s}px Unbounded, "Arial Black", sans-serif', 104, W - M * 2);
    ctx.fillText('TO CHECK IN · +' + (q.xp || 50) + ' XP', W / 2, y + 140);
    ctx.fillStyle = '#bbb';
    ctx.font = '400 54px "DM Sans", Arial, sans-serif';
    spaced(ctx, windowLine(q), W / 2, y + 290, 4);
    spaced(ctx, 'NO APP? POINT YOUR CAMERA AT THE QR TO GET IT', W / 2, y + 375, 4);
    ctx.fillStyle = '#fff';
    ctx.fillRect(M, H - 180, W - M * 2, 4);
    ctx.font = '600 48px "DM Sans", Arial, sans-serif';
    spaced(ctx, (q.venue ? q.venue + ' · ' : '') + 'ONE CHECK-IN PER RAVER', W / 2, H - 95, 10);
    return canvas;
  }

  function slug(q) {
    return (q.eventId + '-checkin-qr').replace(/[^a-z0-9-]/gi, '-');
  }
  function downloadPng(q) {
    return fontsReady().then(function () {
      var canvas = drawPoster(document.createElement('canvas'), q);
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = slug(q) + '.png';
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
          resolve();
        }, 'image/png');
      });
    });
  }
  function posterImage(q) {
    return fontsReady().then(function () {
      var img = new Image();
      img.alt = 'Check-in poster for ' + q.title;
      img.className = 'qr-poster';
      img.src = drawPoster(document.createElement('canvas'), q).toDataURL('image/png');
      return img;
    });
  }
  function load(eventId, kind) {
    return fetch('/admin/api/social/qr?eventId=' + encodeURIComponent(eventId) + '&kind=' + kind, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { location.href = '/admin/login'; throw new Error('SIGNED OUT'); }
        return r.json();
      });
  }

  window.RRQR = { svg: svg, drawPoster: drawPoster, downloadPng: downloadPng, posterImage: posterImage, load: load, windowLine: windowLine };

  /* ---------- stand-alone pages ---------- */
  var root = document.getElementById('qr');
  if (!root) return;
  var eventId = root.getAttribute('data-event');
  var kind = root.getAttribute('data-kind');
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  if (kind === 'print') {
    load(eventId, 'print').then(function (q) {
      if (!q.ok) { root.appendChild(el('p', 'msg err', q.message || q.error)); return; }
      var bar = el('div', 'qr-bar no-print');
      var dl = el('button', 'btn primary', '[ DOWNLOAD PNG ]');
      dl.type = 'button';
      dl.addEventListener('click', function () { downloadPng(q); });
      var pr = el('button', 'btn', '[ PRINT ]');
      pr.type = 'button';
      pr.addEventListener('click', function () { window.print(); });
      var door = el('a', 'btn', '[ DOOR SCREEN ]');
      door.href = '/admin/qr/' + encodeURIComponent(eventId) + '/door';
      var back = el('a', 'btn link', '[ BACK ]');
      back.href = '/admin';
      bar.appendChild(dl); bar.appendChild(pr); bar.appendChild(door); bar.appendChild(back);
      root.appendChild(bar);
      if (q.doorOnly) root.appendChild(el('p', 'msg err no-print', 'DOOR SCREEN ONLY IS ON. THIS PRINTED QR WILL NOT CHECK ANYONE IN.'));
      return posterImage(q).then(function (img) {
        root.appendChild(img);
        if (/[?&]print=1/.test(location.search)) setTimeout(function () { window.print(); }, 300);
      });
    });
    return;
  }

  // Door screen: a new QR every minute, so a photo of it stops working.
  var current = '';
  var wake = null;
  function keepAwake() {
    if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').then(function (l) { wake = l; }).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') keepAwake(); });
  keepAwake();
  var head = el('div', 'door-head');
  var date = el('div', 'door-date');
  var title = el('div', 'door-title');
  var sub = el('div', 'door-sub');
  head.appendChild(date); head.appendChild(title); head.appendChild(sub);
  var box = el('div', 'door-qr');
  var line = el('div', 'door-line', 'SCAN IN THE RECKLESS APP TO CHECK IN · +50 XP');
  var small = el('div', 'door-small', '');
  var state = el('div', 'door-state', '');
  root.appendChild(head); root.appendChild(box); root.appendChild(line); root.appendChild(small); root.appendChild(state);
  function size() {
    return Math.max(160, Math.min(window.innerWidth - 48, window.innerHeight - 330, 900));
  }
  function tick() {
    load(eventId, 'door').then(function (q) {
      if (!q.ok) { state.textContent = q.message || q.error; return; }
      date.textContent = q.dateBadge;
      title.textContent = q.title;
      sub.textContent = q.subtitle;
      line.textContent = 'SCAN IN THE RECKLESS APP TO CHECK IN · +' + (q.xp || 50) + ' XP';
      small.textContent = 'NEW QR EVERY MINUTE · ' + windowLine(q);
      state.textContent = q.open ? '' : 'CHECK-IN IS NOT OPEN YET';
      if (q.url !== current) {
        current = q.url;
        while (box.firstChild) box.removeChild(box.firstChild);
        box.appendChild(svg(q, size()));
      }
    }).catch(function () { state.textContent = 'OFFLINE · RETRYING'; });
  }
  window.addEventListener('resize', function () { current = ''; tick(); });
  tick();
  setInterval(tick, 15000);
})();

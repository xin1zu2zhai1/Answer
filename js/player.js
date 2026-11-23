/*
 * クイズパネル 回答者画面
 *
 * トピック {APP_NS}/{参加コード}/...
 *   state  ホスト → 回答者  いまの状態を丸ごと（retain）
 *   player 回答者 → ホスト  hello / ans / bye
 *   cmd    ホスト → 回答者  rollcall / kick
 */
(function () {
  'use strict';

  var CFG = window.QP_CONFIG;
  var QP = window.QP;
  var NET = window.QP_NET;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var esc = QP.esc;
  var now = QP.now;

  var sess = null;       // {code, name, pid, gid, lastTs, act}
  var answers = {};      // "qid:rid" -> {v, s, sentAt}
  var drafts = {};       // "qid:rid" -> 入力途中の内容
  var st = null;         // ホストから届いた最新の state
  var stAt = 0;          // それを受け取った時刻
  var localDl = 0;       // 制限時間の締め切り（この端末の時計）
  var net = null;
  var netStatus = [];
  var joinStartedAt = 0;
  var lastHelloAt = 0;
  var builtKey = '';     // いま画面に出している回答欄の種類
  var wakeLock = null;
  var libReady = false;

  // ------------------------------------------------------------------
  // 保存
  // ------------------------------------------------------------------
  function saveSess() {
    QP.store.set('player:session', sess);
    QP.store.set('player:answers', answers);
  }
  function clearSess() {
    sess = null;
    answers = {};
    drafts = {};
    st = null;
    QP.store.del('player:session');
    QP.store.del('player:answers');
  }

  function topic(kind) { return QP.topic(sess.code, kind); }
  function roundKey() { return st && st.q && st.q.r ? st.q.id + ':' + st.q.r : ''; }
  function myAnswer() { var k = roundKey(); return k ? answers[k] : null; }

  // ------------------------------------------------------------------
  // 参加・退出
  // ------------------------------------------------------------------
  function join(code, name, pid) {
    var same = sess && sess.code === code;
    sess = {
      code: code,
      name: name,
      pid: pid || (same && sess.pid) || 'p' + NET.randomId(10),
      gid: same ? sess.gid : '',
      lastTs: same ? (sess.lastTs || 0) : 0,
      act: now()
    };
    answers = same ? (QP.store.get('player:answers', {}) || {}) : {};
    drafts = {};
    QP.store.set('player:name', name);
    saveSess();
    st = null;
    builtKey = '';
    joinStartedAt = now();
    showScreen('main');
    render();
    startNet();
    requestWakeLock();
    try { history.replaceState(null, '', location.pathname + '?code=' + code); } catch (e) { /* ignore */ }
  }

  function startNet() {
    if (net) net.stop();
    var pid = sess.pid;
    var code = sess.code;
    net = new NET.MultiBroker({
      brokers: CFG.BROKERS,
      subscriptions: [
        { topic: QP.topic(code, 'state'), qos: 1 },
        { topic: QP.topic(code, 'cmd'), qos: 1 }
      ],
      // 自分が切れたら bye を送ってもらう（遺言メッセージ）
      will: function (cid) {
        return { topic: QP.topic(code, 'player'), payload: JSON.stringify({ t: 'bye', pid: pid, cid: cid }), qos: 1, retain: false };
      },
      onConnect: function (idx, cid) {
        // つながるたびに名乗る
        net.publishTo(idx, topic('player'), helloPayload(cid), { qos: 1 });
      },
      onMessage: onMessage,
      onStatus: function (list) { netStatus = list; renderNet(); },
      onVisible: function () {
        // 画面に戻ってきたら最新の状態を取り直す
        if (!sess) return;
        net.resubscribe(topic('state'), 1);
        sendHelloAll();
        requestWakeLock();
      }
    });
    net.start();
  }

  function stopNet(sendBye) {
    if (!net) return Promise.resolve();
    var n = net;
    net = null;
    var pid = sess ? sess.pid : '';
    var t = sess ? topic('player') : '';
    return n.stop(sendBye && sess ? function (link) {
      link.client.publish(t, JSON.stringify({ t: 'bye', pid: pid, cid: link.cid }), { qos: 1 });
    } : null);
  }

  function leave(message) {
    var name = sess ? sess.name : '';
    var code = sess ? sess.code : '';
    stopNet(true).then(function () { /* done */ });
    clearSess();
    releaseWakeLock();
    showJoin(message ? '' : code, name, message);
  }

  function ended(message) {
    var name = sess ? sess.name : '';
    stopNet(false);
    clearSess();
    releaseWakeLock();
    showJoin('', name, message);
  }

  // ------------------------------------------------------------------
  // 送信
  // ------------------------------------------------------------------
  function currentAnswerForHello() {
    if (!st || st.ph !== 'open' || !st.q) return undefined;
    var a = myAnswer();
    if (!a) return undefined;
    return { q: st.q.id, r: st.q.r, s: a.s, v: a.v };
  }

  function helloPayload(cid) {
    return JSON.stringify({ t: 'hello', pid: sess.pid, cid: cid, name: sess.name, a: currentAnswerForHello() });
  }

  function sendHelloAll() {
    if (!net || !sess) return;
    lastHelloAt = now();
    net.publish(topic('player'), function (link) { return helloPayload(link.cid); }, { qos: 1 });
  }

  function sendAnswer(v) {
    if (!st || st.ph !== 'open' || !st.q || !sess) return;
    if (localDl && now() > localDl) return;
    var k = roundKey();
    var prev = answers[k];
    var s = Math.max(now(), prev ? prev.s + 1 : 0);
    answers[k] = { v: v, s: s, sentAt: now() };
    sess.act = now();
    saveSess();
    publishAnswer();
    renderStatus();
  }

  function publishAnswer() {
    var a = myAnswer();
    if (!a || !net) return;
    a.sentAt = now();
    var body = { q: st.q.id, r: st.q.r, s: a.s, v: a.v };
    net.publish(topic('player'), function (link) {
      return JSON.stringify({ t: 'ans', pid: sess.pid, cid: link.cid, name: sess.name, a: body });
    }, { qos: 1 });
  }

  // 届いたかの確認と、届いていなければ送り直し
  function watchdog() {
    if (!sess || !net) return;
    if (st && st.ph === 'open') {
      var a = myAnswer();
      if (a && (!st.got || st.got[sess.pid] !== a.s) && now() - (a.sentAt || 0) > 3000) publishAnswer();
    }
    if (st && Array.isArray(st.pl) && st.pl.indexOf(sess.pid) < 0 && now() - lastHelloAt > 4000) sendHelloAll();
    if (localDl) renderTimer();
    if (!st) renderWaitHint();
  }

  // ------------------------------------------------------------------
  // 受信
  // ------------------------------------------------------------------
  function onMessage(t, text, idx, packet) {
    if (!sess) return;
    if (t === topic('state')) return onState(text, packet);
    if (t === topic('cmd')) {
      var m = QP.parse(text);
      if (!m) return;
      if (m.t === 'rollcall') {
        // 全員が同時に返事をしないよう、少しずらす
        setTimeout(function () {
          if (net && sess && net.isUp(idx)) net.publishTo(idx, topic('player'), helloPayload(net.cidOf(idx)), { qos: 1 });
        }, Math.random() * 1200);
      } else if (m.t === 'kick' && m.pid === sess.pid) {
        ended('ホストによって参加者から外されました。');
      }
    }
  }

  function onState(text, packet) {
    if (!text) {
      // 保持データが空にされた = ホストがこのコードを使わなくなった
      if (st || sess.gid) ended('ホストがこのセッションを終了しました（参加コードが変わった可能性があります）。');
      return;
    }
    var m = QP.parse(text);
    if (!m || !m.gid || typeof m.ts !== 'number') return;
    // 古い state は無視（複数サーバーの保持データの入れ違い対策）
    if (st && m.ts <= st.ts) return;
    if (!st && m.ts < (sess.lastTs || 0)) return;
    if (now() - (m.act || m.ts) > QP.TTL_MS) {
      ended('このセッションは時間切れで終了しています。ホストに新しい参加コードを確認してください。');
      return;
    }
    if (sess.gid && sess.gid !== m.gid) {
      answers = {};
      drafts = {};
    }
    var prev = st;
    st = m;
    stAt = now();
    sess.gid = m.gid;
    sess.lastTs = m.ts;
    sess.act = now();
    saveSess();

    if (m.ph === 'open' && m.dl) {
      localDl = !packet.retain && typeof m.rem === 'number' ? now() + m.rem : m.dl;
    } else {
      localDl = 0;
    }
    if (m.ph === 'open' && (!prev || prev.ph !== 'open' || !prev.q || prev.q.id !== m.q.id || prev.q.r !== m.q.r)) {
      try { if (navigator.vibrate) navigator.vibrate(80); } catch (e) { /* ignore */ }
    }
    render();
  }

  // ------------------------------------------------------------------
  // 画面
  // ------------------------------------------------------------------
  function showScreen(name) {
    $('#join').hidden = name !== 'join';
    $('#main').hidden = name !== 'main';
  }

  function showJoin(code, name, message) {
    showScreen('join');
    var params = new URLSearchParams(location.search);
    var c = code || params.get('code') || '';
    $('#inCode').value = QP.isCode(c) ? c : '';
    $('#inName').value = name || QP.store.get('player:name', '') || '';
    var msg = $('#joinMsg');
    msg.textContent = message || '';
    msg.hidden = !message;
    $('#joinBtn').disabled = !libReady;
    builtKey = '';
    if (!$('#inCode').value) $('#inCode').focus();
    else if (!$('#inName').value) $('#inName').focus();
  }

  function renderNet() {
    var el = $('#net');
    if (!el) return;
    var up = netStatus.filter(function (s) { return s.state === 'connected'; }).length;
    el.className = 'net ' + (up ? 'ok' : 'ng');
    el.innerHTML = '<span class="dot"></span>' + (up ? '接続中' : '接続を試しています…') +
      '<small>' + up + '/' + (netStatus.length || CFG.BROKERS.length) + '</small>';
  }

  function render() {
    if (!sess) return;
    $('#meName').textContent = sess.name;
    $('#meCode').textContent = QP.formatCode(sess.code);
    renderNet();
    var body = $('#body');
    var key = viewKey();
    if (key !== builtKey) {
      builtKey = key;
      body.innerHTML = buildView();
      bindView();
    }
    renderStatus();
    renderTimer();
    renderWaitHint();
  }

  function viewKey() {
    if (!st) return 'none';
    var q = st.q || {};
    return st.ph + '|' + (q.id || '') + '|' + (q.r || '') + '|' + (st.ph === 'judged' || st.ph === 'final' ? st.ts : '');
  }

  function myScore() { return st && st.sc && st.sc[sess.pid] || 0; }
  function myRank() {
    if (!st || !st.sc || !st.pl) return null;
    var ids = st.pl.filter(function (id) { return id in st.sc; });
    if (ids.indexOf(sess.pid) < 0) return null;
    var r = QP.ranks(ids, function (id) { return st.sc[id] || 0; });
    return { rank: r.rank[sess.pid], total: ids.length };
  }

  function questionHtml() {
    var q = st.q;
    var h = '<div class="qbox"><div class="qno">第' + q.no + '問<small>／全' + st.total + '問</small>' +
      (q.pts ? '<span class="pts">' + q.pts + '点</span>' : '') + '</div>';
    h += '<div class="qtext">' + esc(q.text || '') + '</div>';
    if (st.ph !== 'open' && q.type === 'choice' && q.ch) {
      h += '<ol class="qch">' + q.ch.map(function (c, i) { return '<li><b class="cl c' + i + '">' + QP.choiceLabel(i) + '</b>' + esc(c) + '</li>'; }).join('') + '</ol>';
    }
    h += '</div>';
    return h;
  }

  function answerView(a) {
    var q = st.q;
    if (!a) return '<div class="my-ans none">回答していません</div>';
    if (q.type === 'choice') return '<div class="my-ans"><b class="cl c' + a.v + '">' + QP.choiceLabel(a.v) + '</b>' + esc(q.ch ? q.ch[a.v] : '') + '</div>';
    if (q.type === 'draw') return '<div class="my-ans draw">' + QP.drawSvg(a.v, { width: 9 }) + '</div>';
    return '<div class="my-ans">' + esc(a.v) + '</div>';
  }

  function buildView() {
    if (!st) {
      return '<div class="center-msg"><div class="spinner"></div><div class="big">ホストを探しています…</div><div class="muted" id="waitHint"></div></div>';
    }
    var q = st.q;
    var a = myAnswer();
    if (st.ph === 'final') {
      var rk = myRank();
      return '<div class="result final"><div class="r-label">最終結果</div>' +
        (rk ? '<div class="r-rank">' + rk.rank + '<small>位</small></div><div class="muted">' + rk.total + '人中</div>' : '') +
        '<div class="r-score">' + myScore() + '<small>点</small></div><div class="muted">おつかれさまでした！</div></div>';
    }
    if (st.ph === 'waiting' || !q) {
      return '<div class="center-msg">' +
        (q ? '<div class="qno-big">第' + q.no + '問</div><div class="big">まもなく出題されます</div>' : '<div class="big">クイズの開始を待っています</div>') +
        '<div class="muted">いまの得点：<b>' + myScore() + '</b>点</div></div>';
    }
    if (st.ph === 'open') {
      var h = questionHtml();
      h += '<div class="timer" id="timer" hidden></div>';
      h += '<div class="answer-area">' + answerInputHtml(q) + '</div>';
      h += '<div class="ans-status" id="ansStatus"></div>';
      return h;
    }
    if (st.ph === 'closed') {
      return questionHtml() + '<div class="phase-msg">締め切りました</div><div class="label">あなたの回答</div>' + answerView(a) +
        '<div class="ans-status" id="ansStatus"></div><div class="muted center">正解発表をお待ちください</div>';
    }
    if (st.ph === 'judged') {
      var j = st.res ? st.res[sess.pid] : undefined;
      var mark = j === 1 ? '<div class="judge ok"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="38"/></svg><div>正解！</div></div>'
        : j === 0 ? '<div class="judge ng"><svg viewBox="0 0 100 100"><path d="M18 18 L82 82 M82 18 L18 82"/></svg><div>ざんねん…</div></div>'
          : '<div class="judge none"><div>判定を待っています</div></div>';
      return mark + (st.ca ? '<div class="correct"><span>正解</span>' + esc(st.ca) + '</div>' : '') +
        '<div class="label">あなたの回答</div>' + answerView(a) +
        '<div class="score-line">いまの得点 <b>' + myScore() + '</b>点' + (myRank() ? '（' + myRank().rank + '位）' : '') + '</div>' +
        questionHtml();
    }
    return '';
  }

  function answerInputHtml(q) {
    var k = roundKey();
    var a = answers[k];
    if (q.type === 'choice') {
      return '<div class="choices">' + (q.ch || []).map(function (c, i) {
        return '<button class="choice c' + i + '" data-choice="' + i + '"><b class="cl c' + i + '">' + QP.choiceLabel(i) + '</b><span>' + esc(c) + '</span></button>';
      }).join('') + '</div>';
    }
    if (q.type === 'draw') {
      return '<div class="draw-wrap"><canvas id="pad"></canvas></div>' +
        '<div class="draw-tools"><button class="btn" id="undoBtn">1つ戻す</button><button class="btn" id="clearBtn">全部消す</button>' +
        '<button class="btn primary" id="sendDraw">' + (a ? 'この絵で送り直す' : 'この絵で回答する') + '</button></div>';
    }
    var d = drafts[k] != null ? drafts[k] : (a ? a.v : '');
    return '<form id="textForm" class="text-form" autocomplete="off"><input id="textAns" type="text" maxlength="' + CFG.MAX_TEXT_LEN + '" enterkeyhint="send" placeholder="ここに答えを入力" value="' + esc(d) + '">' +
      '<button class="btn primary" type="submit">' + (a ? '回答を変更' : '回答する') + '</button></form>';
  }

  function bindView() {
    var form = $('#textForm');
    if (form) {
      var inp = $('#textAns');
      inp.addEventListener('input', function () { drafts[roundKey()] = inp.value; });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = inp.value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CFG.MAX_TEXT_LEN);
        if (!v) { QP.toast('答えを入力してください'); return; }
        sendAnswer(v);
        $('button[type=submit]', form).textContent = '回答を変更';
        inp.blur();
      });
    }
    var choices = document.querySelectorAll('[data-choice]');
    Array.prototype.forEach.call(choices, function (b) {
      b.addEventListener('click', function () { sendAnswer(+b.dataset.choice); });
    });
    if ($('#pad')) setupPad();
  }

  function renderStatus() {
    var el = $('#ansStatus');
    if (!el || !st || !sess) return;
    var a = myAnswer();
    // 選択式は選んだボタンを光らせる
    Array.prototype.forEach.call(document.querySelectorAll('[data-choice]'), function (b) {
      b.classList.toggle('selected', !!a && a.v === +b.dataset.choice);
    });
    if (!a) {
      el.className = 'ans-status';
      el.innerHTML = st.ph === 'open' ? '' : '';
      return;
    }
    var got = st.got && st.got[sess.pid];
    if (got === a.s) {
      el.className = 'ans-status ok';
      el.innerHTML = '✓ ホストに届きました' + (st.ph === 'open' ? '<small>締め切りまでは変更できます</small>' : '');
    } else if (st.ph === 'open') {
      el.className = 'ans-status wait';
      el.innerHTML = '送信中…<small>届かないときは自動で送り直します</small>';
    } else {
      el.className = 'ans-status ng';
      el.innerHTML = got ? '最後に変更した回答は締め切りに間に合わなかったかもしれません' : 'この回答はホストに届かなかったかもしれません';
    }
  }

  function renderTimer() {
    var el = $('#timer');
    if (!el) return;
    if (!st || st.ph !== 'open' || !localDl) { el.hidden = true; return; }
    var remain = Math.max(0, Math.ceil((localDl - now()) / 1000));
    el.hidden = false;
    el.textContent = remain > 0 ? 'のこり ' + remain + ' 秒' : '時間切れ';
    el.classList.toggle('hurry', remain <= 5);
    var disable = remain <= 0;
    Array.prototype.forEach.call(document.querySelectorAll('.answer-area button, .answer-area input'), function (x) {
      x.disabled = disable;
    });
  }

  function renderWaitHint() {
    var el = $('#waitHint');
    if (!el) return;
    var up = netStatus.filter(function (s) { return s.state === 'connected'; }).length;
    var waited = now() - joinStartedAt;
    if (!up) {
      el.textContent = waited > 12000 ? 'サーバーにつながりません。Wi-Fi とスマホ回線を切り替えるか、ログインが必要な Wi-Fi ならブラウザでログインを済ませてください。' : 'サーバーに接続しています…';
    } else {
      el.textContent = waited > 8000 ? '参加コード ' + QP.formatCode(sess.code) + ' のホストが見つかりません。コードが正しいか確認してください（このまま待つこともできます）。' : '';
    }
  }

  // ---- 手書き ----
  function setupPad() {
    var canvas = $('#pad');
    var k = roundKey();
    var a = answers[k];
    if (!drafts[k]) drafts[k] = a && a.v && a.v.s ? a.v.s.map(function (s) { return s.slice(); }) : [];
    var strokes = drafts[k];
    var W = CFG.DRAW_W, H = CFG.DRAW_H;
    var ctx = canvas.getContext('2d');
    var cur = null;
    var total = function () { return strokes.reduce(function (n, s) { return n + s.length / 2; }, 0); };

    function size() {
      var r = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      draw();
    }
    function draw() {
      var sx = canvas.width / W;
      var sy = canvas.height / H;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 9;
      ctx.strokeStyle = '#111';
      ctx.fillStyle = '#111';
      strokes.forEach(function (s) {
        if (s.length === 2) {
          ctx.beginPath();
          ctx.arc(s[0], s[1], 4.5, 0, Math.PI * 2);
          ctx.fill();
          return;
        }
        ctx.beginPath();
        ctx.moveTo(s[0], s[1]);
        for (var i = 2; i < s.length; i += 2) ctx.lineTo(s[i], s[i + 1]);
        ctx.stroke();
      });
    }
    function pt(e) {
      var r = canvas.getBoundingClientRect();
      var x = Math.round(Math.max(0, Math.min(W, (e.clientX - r.left) / r.width * W)));
      var y = Math.round(Math.max(0, Math.min(H, (e.clientY - r.top) / r.height * H)));
      return [x, y];
    }
    canvas.addEventListener('pointerdown', function (e) {
      if (canvas.dataset.off) return;
      if (total() >= CFG.MAX_DRAW_POINTS) { QP.toast('これ以上は描けません。「1つ戻す」で減らしてください'); return; }
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      var p = pt(e);
      cur = [p[0], p[1]];
      strokes.push(cur);
      draw();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!cur) return;
      e.preventDefault();
      var events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      events.forEach(function (ev) {
        var p = pt(ev);
        var lx = cur[cur.length - 2], ly = cur[cur.length - 1];
        if ((p[0] - lx) * (p[0] - lx) + (p[1] - ly) * (p[1] - ly) < 9) return;
        if (total() >= CFG.MAX_DRAW_POINTS) return;
        cur.push(p[0], p[1]);
      });
      draw();
    });
    var end = function () { cur = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    $('#undoBtn').addEventListener('click', function () { strokes.pop(); draw(); });
    $('#clearBtn').addEventListener('click', function () { strokes.length = 0; draw(); });
    $('#sendDraw').addEventListener('click', function () {
      if (!strokes.length) { QP.toast('絵を描いてから送ってください'); return; }
      sendAnswer({ s: strokes.map(function (s) { return s.slice(); }) });
      $('#sendDraw').textContent = 'この絵で送り直す';
    });
    window.addEventListener('resize', size);
    size();
  }

  // ---- 画面を暗くしない（対応ブラウザのみ） ----
  function requestWakeLock() {
    try {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || !sess) return;
      if (wakeLock && !wakeLock.released) return;
      navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
  }

  // ------------------------------------------------------------------
  // 起動
  // ------------------------------------------------------------------
  function boot() {
    var params = new URLSearchParams(location.search);
    var urlCode = params.get('code');

    $('#joinForm').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!libReady) return;
      var code = $('#inCode').value.replace(/\D/g, '');
      var name = $('#inName').value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CFG.MAX_NAME_LEN);
      var msg = $('#joinMsg');
      if (!QP.isCode(code)) { msg.textContent = '参加コードは6桁の数字です'; msg.hidden = false; return; }
      if (!name) { msg.textContent = '名前を入力してください'; msg.hidden = false; return; }
      var prev = QP.store.get('player:session', null);
      join(code, name, prev && prev.code === code ? prev.pid : null);
    });
    $('#inCode').addEventListener('input', function () {
      var v = this.value.replace(/\D/g, '').slice(0, 6);
      if (v !== this.value) this.value = v;
    });
    $('#leaveBtn').addEventListener('click', function () {
      if (confirm('クイズから退出しますか？')) leave();
    });

    var saved = QP.store.get('player:session', null);
    var savedOk = saved && QP.isCode(saved.code) && saved.pid && saved.name && now() - (saved.act || 0) < QP.TTL_MS;
    if (savedOk && (!urlCode || urlCode === saved.code)) {
      sess = saved;
      answers = QP.store.get('player:answers', {}) || {};
    }

    if (!QP.storageOk) $('#storageWarn').hidden = false;

    showJoin(urlCode, saved && saved.name, '');
    $('#joinBtn').disabled = true;
    $('#joinBtn').textContent = '準備しています…';

    QP.loadMqtt().then(function () {
      libReady = true;
      $('#joinBtn').disabled = false;
      $('#joinBtn').textContent = '参加する';
      if (sess) {
        // 前回の続きから（自動で再接続）
        join(sess.code, sess.name, sess.pid);
      }
    }).catch(function () {
      var msg = $('#joinMsg');
      msg.textContent = 'ライブラリの読み込みに失敗しました。広告ブロッカーやコンテンツブロッカーを止めるか、別のブラウザでお試しください。';
      msg.hidden = false;
      $('#joinBtn').textContent = '参加できません';
    });

    setInterval(watchdog, 1000);
    document.addEventListener('visibilitychange', requestWakeLock);
  }

  window.QP_PLAYER = {
    get state() { return { sess: sess, st: st, answers: answers }; }
  };

  boot();
})();

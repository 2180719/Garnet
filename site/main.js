(function () {
  'use strict';
  var root = document.documentElement;
  var KEY = 'ruby-theme';

  function safeGet() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function safeSet(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function systemDark() { return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches; }
  function current() { return root.getAttribute('data-theme') || (systemDark() ? 'dark' : 'light'); }

  var saved = safeGet();
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);

  var toggle = document.getElementById('theme-toggle');
  function syncToggle() {
    if (!toggle) return;
    var dark = current() === 'dark';
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    toggle.title = dark ? 'Light theme' : 'Dark theme';
  }
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      safeSet(next);
      syncToggle();
    });
    syncToggle();
  }

  // Local interface specimens; these do not connect to a running agent.
  var previews = document.querySelectorAll('[data-preview]');
  previews.forEach(function (button) {
    button.addEventListener('click', function () {
      previews.forEach(function (item) {
        var selected = item === button;
        item.setAttribute('aria-pressed', String(selected));
        document.getElementById('preview-' + item.getAttribute('data-preview')).hidden = !selected;
      });
    });
  });

  // Copy install snippet
  var copyBtn = document.getElementById('copy-btn');
  var code = document.getElementById('install-code');
  if (copyBtn && code) {
    copyBtn.addEventListener('click', function () {
      var text = code.textContent.trim();
      var done = function (ok) {
        copyBtn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        try {
          var r = document.createRange(); r.selectNodeContents(code);
          var s = getSelection(); s.removeAllRanges(); s.addRange(r); done(false);
        } catch (e) { done(false); }
      }
    });
  }

  // Optional demo chat
  var endpoint = (document.body.getAttribute('data-demo-endpoint') || '').trim().replace(/\/+$/, '');
  var demo = document.getElementById('demo');
  if (endpoint && demo) {
    demo.hidden = false;
    var form = document.getElementById('demo-form');
    var input = document.getElementById('demo-input');
    var log = document.getElementById('demo-log');
    var status = document.getElementById('demo-status');
    var sendBtn = document.getElementById('demo-send');
    var history = [];
    var MAX = 500;

    var add = function (role, text) {
      var p = document.createElement('p');
      p.className = 'msg msg-' + role;
      p.textContent = text;
      log.appendChild(p);
      log.scrollTop = log.scrollHeight;
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim().slice(0, MAX);
      if (!text) return;
      input.value = '';
      add('user', text);
      history.push({ role: 'user', content: text });
      history = history.slice(-6);
      sendBtn.disabled = true;
      status.textContent = 'Ruby is thinking…';
      var headers = { 'Content-Type': 'application/json' };
      fetch(endpoint + '/v1/demo/chat/completions', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ model: 'ruby-demo', stream: false, messages: history })
      }).then(function (r) {
        if (!r.ok) throw new Error('status ' + r.status);
        return r.json();
      }).then(function (data) {
        var reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (typeof reply !== 'string' || !reply) throw new Error('empty');
        add('ruby', reply);
        history.push({ role: 'assistant', content: reply });
        status.textContent = '';
      }).catch(function () {
        history.pop();
        status.textContent = 'The demo is unavailable right now (it may have hit its daily budget). Please try again later.';
      }).then(function () { sendBtn.disabled = false; input.focus(); });
    });
  }
})();

// renderer/sidebar-v2.js
// Extends sidebar.js with: body rules pane, HAR export button, per-tab proxy UI,
// and full header inspector on row click.
(function () {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // ── inject extra tabs ──
  const tabStrip = sidebar.querySelector('.sb-tabs');
  if (tabStrip && !tabStrip.querySelector('[data-pane="body"]')) {
    const bodyTab = document.createElement('button');
    bodyTab.className = 'sb-tab';
    bodyTab.dataset.pane = 'body';
    bodyTab.textContent = 'body';
    tabStrip.appendChild(bodyTab);
  }

  // ── body rules pane ──
  const paneHost = sidebar.querySelector('.sb-pane[data-pane="rules"]');
  if (paneHost && !sidebar.querySelector('.sb-pane[data-pane="body"]')) {
    const bodyPane = document.createElement('section');
    bodyPane.className = 'sb-pane';
    bodyPane.dataset.pane = 'body';
    bodyPane.innerHTML =
      '<div class="sb-toolbar">' +
        '<button id="body-new" class="sb-btn">new rule</button>' +
        '<button id="body-reset" class="sb-btn">reset defaults</button>' +
      '</div>' +
      '<div id="body-list" class="rules-list"></div>';
    sidebar.insertBefore(bodyPane, sidebar.querySelector('.sb-pane[data-pane="proxy"]'));
  }

  // re-bind pane switcher (sidebar.js ran before/independently)
  const tabs = sidebar.querySelectorAll('.sb-tab');
  const panes = sidebar.querySelectorAll('.sb-pane');
  tabs.forEach((t) => {
    t.onclick = () => {
      tabs.forEach((x) => x.classList.remove('active'));
      panes.forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      const pane = sidebar.querySelector('.sb-pane[data-pane="' + t.dataset.pane + '"]');
      if (pane) pane.classList.add('active');
    };
  });

  // ── body rule editor ──
  const bodyList = document.getElementById('body-list');
  const bodyNew = document.getElementById('body-new');
  const bodyReset = document.getElementById('body-reset');

  function bodyRow(rule) {
    const el = document.createElement('div');
    el.className = 'rule-row' + (rule.enabled ? '' : ' disabled');
    el.dataset.id = rule.id;

    el.innerHTML =
      '<div class="rr-head">' +
        '<label class="rr-toggle"><input type="checkbox" ' + (rule.enabled ? 'checked' : '') + ' data-act="toggle"></label>' +
        '<input class="rr-id" value="' + rule.id + '" readonly>' +
        '<button class="rr-del" title="delete">×</button>' +
      '</div>' +
      '<div class="rr-body">' +
        '<label>match<input class="rr-match" value="' + (rule.match || '').replace(/"/g, '&quot;') + '"></label>' +
        '<label>content-type<input class="rr-ct" value="' + (rule.contentType || '').replace(/"/g, '&quot;') + '"></label>' +
        '<label>mode<select class="rr-mode">' +
          '<option value="json"' + (rule.mode === 'json' ? ' selected' : '') + '>json</option>' +
          '<option value="text"' + (rule.mode === 'text' ? ' selected' : '') + '>text</option>' +
        '</select></label>' +
        '<label>order<input class="rr-order" type="number" value="' + (rule.order || 100) + '"></label>' +
        '<label>transform (data) =&gt; data<textarea class="rr-xf" rows="6">' +
          (rule.transform || '').replace(/</g, '&lt;') +
        '</textarea></label>' +
      '</div>';

    el.querySelector('[data-act="toggle"]').addEventListener('change', async (e) => {
      await window.ghost.bodySetEnabled(rule.id, e.target.checked);
      el.classList.toggle('disabled', !e.target.checked);
    });

    el.querySelector('.rr-del').addEventListener('click', async () => {
      await window.ghost.bodyRemove(rule.id);
      refreshBody();
    });

    const commit = async () => {
      await window.ghost.bodyUpdate(rule.id, {
        match: el.querySelector('.rr-match').value,
        contentType: el.querySelector('.rr-ct').value,
        mode: el.querySelector('.rr-mode').value,
        order: parseInt(el.querySelector('.rr-order').value, 10) || 100,
        transform: el.querySelector('.rr-xf').value
      });
    };

    el.querySelector('.rr-match').addEventListener('blur', commit);
    el.querySelector('.rr-ct').addEventListener('blur', commit);
    el.querySelector('.rr-mode').addEventListener('change', commit);
    el.querySelector('.rr-order').addEventListener('blur', commit);
    el.querySelector('.rr-xf').addEventListener('blur', commit);

    return el;
  }

  async function refreshBody() {
    if (!bodyList) return;
    const rules = await window.ghost.bodyList();
    bodyList.innerHTML = '';
    for (const r of rules) bodyList.appendChild(bodyRow(r));
  }

  if (bodyNew) {
    bodyNew.addEventListener('click', async () => {
      await window.ghost.bodyAdd({
        id: '',
        enabled: true,
        match: '.*/api/.*',
        contentType: 'application/json',
        mode: 'json',
        order: 100,
        transform: 'return data;'
      });
      refreshBody();
    });
  }

  if (bodyReset) {
    bodyReset.addEventListener('click', async () => {
      await window.ghost.bodyReset();
      refreshBody();
    });
  }

  refreshBody();

  // ── HAR export button in the requests pane ──
  const requestsToolbar = sidebar.querySelector('.sb-pane[data-pane="requests"] .sb-toolbar');
  if (requestsToolbar && !document.getElementById('log-har')) {
    const harBtn = document.createElement('button');
    harBtn.id = 'log-har';
    harBtn.className = 'sb-btn';
    harBtn.textContent = 'export har';
    harBtn.addEventListener('click', async () => {
      const prev = harBtn.textContent;
      harBtn.textContent = 'exporting...';
      try {
        const res = await window.ghost.harExport({ title: 'Ghost session' });
        harBtn.textContent = res && res.ok ? ('saved: ' + res.entryCount) : 'cancelled';
      } catch (e) {
        harBtn.textContent = 'failed';
      }
      setTimeout(() => { harBtn.textContent = prev; }, 1600);
    });
    requestsToolbar.appendChild(harBtn);
  }

  // ── click a log row → open header inspector ──
  const listEl = document.getElementById('log-list');
  if (listEl) {
    listEl.addEventListener('click', async (e) => {
      const row = e.target.closest('.log-row');
      if (!row) return;
      const id = parseInt(row.dataset.id, 10);
      const all = await window.ghost.logAll();
      const rec = all.find((r) => r.id === id);
      if (!rec) return;
      showInspector(rec);
    });
  }

  function showInspector(rec) {
    const existing = document.getElementById('ghost-inspector');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = 'ghost-inspector';
    el.className = 'ghost-inspector';

    const fmt = (obj) => {
      if (!obj) return '(none)';
      if (typeof obj === 'string') return obj;
      return Object.entries(obj).map(([k, v]) => k + ': ' + v).join('\n');
    };

    el.innerHTML =
      '<div class="gi-head">' +
        '<span class="gi-method">' + (rec.method || 'GET') + '</span>' +
        '<span class="gi-status">' + (rec.status || '···') + '</span>' +
        '<button class="gi-close">×</button>' +
      '</div>' +
      '<div class="gi-url">' + (rec.url || '') + '</div>' +
      '<div class="gi-section"><div class="gi-label">request headers</div>' +
        '<pre class="gi-pre">' + fmt(rec.reqHeaders) + '</pre></div>' +
      '<div class="gi-section"><div class="gi-label">response headers</div>' +
        '<pre class="gi-pre">' + fmt(rec.resHeaders) + '</pre></div>' +
      '<div class="gi-section"><div class="gi-label">meta</div>' +
        '<pre class="gi-pre">' +
          'duration: ' + (rec.duration || 0) + 'ms\n' +
          'bytes:    ' + (rec.bytes || 0) + '\n' +
          'tab id:   ' + (rec.tabId || '—') + '\n' +
          'via proxy: ' + (rec.viaProxy ? 'yes' : 'no') + '\n' +
          'blocked:  ' + (rec.blocked ? 'yes' : 'no') +
        '</pre></div>';

    el.querySelector('.gi-close').addEventListener('click', () => el.remove());
    document.body.appendChild(el);
  }

  // ── per-tab proxy UI in proxy pane ──
  const proxyPane = sidebar.querySelector('.sb-pane[data-pane="proxy"]');
  if (proxyPane && !document.getElementById('tab-proxy-list')) {
    const section = document.createElement('div');
    section.className = 'sb-info';
    section.innerHTML =
      '<div><span>global proxy</span>' +
        '<select id="global-proxy" class="sb-select">' +
          '<option value="direct">direct</option>' +
          '<option value="system">system</option>' +
          '<option value="http://127.0.0.1:8899">local proxy</option>' +
        '</select></div>';
    proxyPane.insertBefore(section, proxyPane.querySelector('.sb-toolbar'));

    const globalSel = document.getElementById('global-proxy');
    window.ghost.proxyGet().then((state) => {
      if (state && state.global) globalSel.value = state.global.proxy || 'direct';
    });

    globalSel.addEventListener('change', async () => {
      await window.ghost.proxySetGlobal(globalSel.value);
    });

    const tabSection = document.createElement('div');
    tabSection.className = 'sb-info';
    tabSection.id = 'tab-proxy-list';
    tabSection.innerHTML = '<div><span>per-tab overrides</span><b>see tab menu</b></div>';
    proxyPane.appendChild(tabSection);
  }
})();
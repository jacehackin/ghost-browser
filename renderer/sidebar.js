// renderer/sidebar.js
(function () {
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-handle');
  const closeBtn = document.getElementById('sb-close');

  if (!sidebar || !handle) return;

  function open() { sidebar.setAttribute('aria-hidden', 'false'); sidebar.classList.add('open'); }
  function close() { sidebar.setAttribute('aria-hidden', 'true'); sidebar.classList.remove('open'); }
  function toggle() { sidebar.classList.contains('open') ? close() : open(); }

  handle.addEventListener('click', toggle);
  closeBtn.addEventListener('click', close);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '\\') { e.preventDefault(); toggle(); }
  });

  // ── pane switching ──
  const tabs = sidebar.querySelectorAll('.sb-tab');
  const panes = sidebar.querySelectorAll('.sb-pane');
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.remove('active'));
      panes.forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      const pane = sidebar.querySelector(`.sb-pane[data-pane="${t.dataset.pane}"]`);
      if (pane) pane.classList.add('active');
    });
  });

  // ── request log ──
  const listEl = document.getElementById('log-list');
  const filterEl = document.getElementById('log-filter');
  const statsEl = document.getElementById('log-stats');
  const clearBtn = document.getElementById('log-clear');

  let entries = [];
  let filter = '';

  function statusClass(code) {
    if (code >= 500) return 's-5xx';
    if (code >= 400) return 's-4xx';
    if (code >= 300) return 's-3xx';
    if (code >= 200) return 's-2xx';
    return 's-none';
  }

  function shortUrl(u) {
    try {
      const p = new URL(u);
      const path = p.pathname.length > 42 ? p.pathname.slice(0, 42) + '…' : p.pathname;
      return p.hostname + path;
    } catch (e) {
      return u.slice(0, 60);
    }
  }

  function row(rec) {
    const el = document.createElement('div');
    el.className = 'log-row ' + statusClass(rec.status);
    el.dataset.id = rec.id;
    el.innerHTML =
      `<span class="m">${(rec.method || '').toUpperCase().padEnd(4, ' ')}</span>` +
      `<span class="s">${rec.status || '···'}</span>` +
      `<span class="u" title="${rec.url}">${shortUrl(rec.url)}</span>`;
    el.addEventListener('click', () => {
      // eslint-disable-next-line no-console
      console.log('%c[ghost] request', 'color:#3b82f6', rec);
    });
    return el;
  }

  function render() {
    const f = filter.toLowerCase();
    const visible = entries.filter((r) => {
      if (!f) return true;
      if ((r.url || '').toLowerCase().includes(f)) return true;
      if (String(r.status || '').includes(f)) return true;
      if ((r.method || '').toLowerCase().includes(f)) return true;
      return false;
    });

    listEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const r of visible.slice(-400)) frag.appendChild(row(r));
    listEl.appendChild(frag);
    listEl.scrollTop = listEl.scrollHeight;

    const st = entries.reduce(
      (acc, r) => {
        acc.total++;
        if (r.status >= 400) acc.err++;
        if (r.blocked) acc.blocked++;
        return acc;
      },
      { total: 0, err: 0, blocked: 0 }
    );
    statsEl.textContent = `${st.total} total · ${st.err} errors · ${st.blocked} blocked`;
  }

  filterEl.addEventListener('input', () => { filter = filterEl.value; render(); });
  clearBtn.addEventListener('click', async () => {
    await window.ghost.logClear();
    entries = [];
    render();
  });

  // load initial
  window.ghost.logAll().then((all) => { entries = all || []; render(); });

  // stream
  window.ghost.onLogEntry((rec) => {
    if (rec && rec.__clear) { entries = []; render(); return; }
    entries.push(rec);
    if (entries.length > 2000) entries.shift();
    render();
  });

  // ── rules editor ──
  const rulesList = document.getElementById('rules-list');
  const rulesNew = document.getElementById('rules-new');
  const rulesReset = document.getElementById('rules-reset');

  function ruleRow(rule) {
    const el = document.createElement('div');
    el.className = 'rule-row' + (rule.enabled ? '' : ' disabled');
    el.dataset.id = rule.id;

    el.innerHTML =
      `<div class="rr-head">` +
        `<label class="rr-toggle"><input type="checkbox" ${rule.enabled ? 'checked' : ''} data-act="toggle"></label>` +
        `<input class="rr-id" value="${rule.id}" readonly>` +
        `<button class="rr-del" title="delete">×</button>` +
      `</div>` +
      `<div class="rr-body">` +
        `<label>match<input class="rr-match" value="${(rule.match || '').replace(/"/g, '&quot;')}"></label>` +
        `<label>phase<select class="rr-phase">` +
          `<option value="request"${rule.phase === 'request' ? ' selected' : ''}>request</option>` +
          `<option value="response"${rule.phase === 'response' ? ' selected' : ''}>response</option>` +
          `<option value="both"${rule.phase === 'both' ? ' selected' : ''}>both</option>` +
        `</select></label>` +
        `<label>set (json)<textarea class="rr-set" rows="3">${JSON.stringify(rule.set || {})}</textarea></label>` +
        `<label>remove (comma list)<input class="rr-remove" value="${(rule.remove || []).join(', ')}"></label>` +
      `</div>`;

    el.querySelector('[data-act="toggle"]').addEventListener('change', async (e) => {
      await window.ghost.rulesSetEnabled(rule.id, e.target.checked);
      el.classList.toggle('disabled', !e.target.checked);
    });

    el.querySelector('.rr-del').addEventListener('click', async () => {
      await window.ghost.rulesRemove(rule.id);
      refreshRules();
    });

    const commit = async () => {
      let setObj = {};
      try { setObj = JSON.parse(el.querySelector('.rr-set').value || '{}'); } catch (er) { /* keep last good */ }
      const removeArr = el.querySelector('.rr-remove').value
        .split(',').map((s) => s.trim()).filter(Boolean);
      await window.ghost.rulesUpdate(rule.id, {
        match: el.querySelector('.rr-match').value,
        phase: el.querySelector('.rr-phase').value,
        set: setObj,
        remove: removeArr
      });
    };

    el.querySelector('.rr-match').addEventListener('blur', commit);
    el.querySelector('.rr-phase').addEventListener('change', commit);
    el.querySelector('.rr-set').addEventListener('blur', commit);
    el.querySelector('.rr-remove').addEventListener('blur', commit);

    return el;
  }

  async function refreshRules() {
    const rules = await window.ghost.rulesList();
    rulesList.innerHTML = '';
    for (const r of rules) rulesList.appendChild(ruleRow(r));
  }

  rulesNew.addEventListener('click', async () => {
    await window.ghost.rulesAdd({
      id: '',
      enabled: true,
      match: '.*',
      phase: 'both',
      set: {},
      remove: []
    });
    refreshRules();
  });

  rulesReset.addEventListener('click', async () => {
    await window.ghost.rulesReset();
    refreshRules();
  });

  refreshRules();

  // ── proxy pane ──
  window.ghost.getProxyUrl().then((u) => { document.getElementById('p-url').textContent = u; });
  window.ghost.getProxyPort().then((p) => { document.getElementById('p-port').textContent = p; });

  document.getElementById('p-clear').addEventListener('click', async () => {
    await window.ghost.clearSession();
  });

  document.getElementById('p-cache').addEventListener('click', async () => {
    if (window.ghost.clearCache) await window.ghost.clearCache();
  });
})();
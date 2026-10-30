// renderer/app.js
const viewport = document.getElementById('viewport');
const tabstrip = document.getElementById('tabstrip');
const urlbar = document.getElementById('urlbar');
const statusEl = document.getElementById('status');

const btnBack = document.getElementById('back');
const btnForward = document.getElementById('forward');
const btnReload = document.getElementById('reload');
const btnHome = document.getElementById('home');
const btnClear = document.getElementById('clear');
const btnNewTab = document.getElementById('newtab');

let tabs = [];
let activeTab = null;
let tabCounter = 0;
let proxyUrl = '';

const HOME_HTML = `
  <div class="home-page">
    <div class="logo">ghost</div>
    <div class="hint">
      cors disabled · csp stripped · proxy live<br>
      <b>type a url. it just works.</b><br>
      anything blocked still? route it through <span id="proxyhint"></span>
    </div>
  </div>
`;

function normalizeUrl(input) {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+\.[\w.-]+(\/.*)?$/.test(s)) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

function updateNavState() {
  if (!activeTab) return;
  urlbar.value = activeTab.url || '';
  btnBack.disabled = !activeTab.view.canGoBack();
  btnForward.disabled = !activeTab.view.canGoForward();
}

function setActiveTab(tab) {
  if (activeTab) {
    activeTab.view.classList.remove('active');
    activeTab.el.classList.remove('active');
  }
  activeTab = tab;
  tab.view.classList.add('active');
  tab.el.classList.add('active');
  updateNavState();
}

function attachViewEvents(tab) {
  const v = tab.view;

  v.addEventListener('did-start-loading', () => {
    if (tab === activeTab) statusEl.textContent = 'loading…';
  });

  v.addEventListener('did-stop-loading', () => {
    if (tab === activeTab) statusEl.textContent = `proxy: ${proxyUrl || 'ready'}`;
    tab.url = v.getURL();
    updateNavState();
  });

  v.addEventListener('page-title-updated', (e) => {
    tab.title = e.title || 'untitled';
    tab.el.querySelector('.title').textContent = tab.title;
  });

  v.addEventListener('page-favicon-updated', (e) => {
    if (e.favicons && e.favicons[0]) {
      tab.favicon = e.favicons[0];
    }
  });

  v.addEventListener('did-navigate', (e) => {
    tab.url = e.url;
    if (tab === activeTab) updateNavState();
  });

  v.addEventListener('did-navigate-in-page', (e) => {
    tab.url = e.url;
    if (tab === activeTab) updateNavState();
  });

  v.addEventListener('new-window', (e) => {
    e.preventDefault();
    createTab(e.url);
  });
}

function createTab(url) {
  tabCounter += 1;
  const id = tabCounter;

  const el = document.createElement('div');
  el.className = 'tab';
  el.innerHTML = `<span class="title">new tab</span><span class="close">×</span>`;
  el.querySelector('.close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeTab(id);
  });
  el.addEventListener('click', () => {
    const t = tabs.find((x) => x.id === id);
    if (t) setActiveTab(t);
  });
  tabstrip.appendChild(el);

  const view = document.createElement('webview');
  view.setAttribute('allowpopups', 'true');
  view.setAttribute('partition', 'persist:ghost');
  view.setAttribute('webpreferences', 'webSecurity=no,allowRunningInsecureContent=yes,contextIsolation=no');
  view.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(HOME_HTML);
  viewport.appendChild(view);

  const tab = {
    id,
    el,
    view,
    title: 'new tab',
    url: '',
    favicon: null
  };
  tabs.push(tab);
  attachViewEvents(tab);

  setActiveTab(tab);
  if (url) navigateTab(tab, url);

  return tab;
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [removed] = tabs.splice(idx, 1);
  removed.el.remove();
  removed.view.remove();

  if (activeTab === removed) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    if (next) setActiveTab(next);
    else createTab();
  }
}

function navigateTab(tab, url) {
  const target = normalizeUrl(url);
  if (!target) return;
  tab.url = target;
  tab.view.loadURL(target);
  if (tab === activeTab) urlbar.value = target;
}

function navigateActive(url) {
  if (!activeTab) return;
  navigateTab(activeTab, url);
}

// ── URL bar ──
urlbar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    navigateActive(urlbar.value);
    urlbar.blur();
  }
});

urlbar.addEventListener('focus', () => urlbar.select());

// ── Nav buttons ──
btnBack.addEventListener('click', () => activeTab && activeTab.view.canGoBack() && activeTab.view.goBack());
btnForward.addEventListener('click', () => activeTab && activeTab.view.canGoForward() && activeTab.view.goForward());
btnReload.addEventListener('click', () => activeTab && activeTab.view.reload());
btnHome.addEventListener('click', () => {
  if (!activeTab) return;
  activeTab.view.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(HOME_HTML);
});
btnNewTab.addEventListener('click', () => createTab());
btnClear.addEventListener('click', async () => {
  statusEl.textContent = 'clearing…';
  await window.ghost.clearSession();
  statusEl.textContent = 'cleared';
  setTimeout(() => { statusEl.textContent = `proxy: ${proxyUrl}`; }, 800);
});

// ── Global hotkeys ──
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key === 't') { e.preventDefault(); createTab(); }
  if (mod && e.key === 'w') { e.preventDefault(); if (activeTab) closeTab(activeTab.id); }
  if (mod && e.key === 'l') { e.preventDefault(); urlbar.focus(); }
  if (mod && e.key === 'r') { e.preventDefault(); if (activeTab) activeTab.view.reload(); }
  if (e.key === 'F12') { e.preventDefault(); if (activeTab) activeTab.view.openDevTools(); }
  if (mod && e.key === 'Tab') {
    e.preventDefault();
    if (tabs.length < 2) return;
    const i = tabs.indexOf(activeTab);
    const next = tabs[(i + 1) % tabs.length];
    setActiveTab(next);
  }
});

// ── Boot ──
(async function boot() {
  proxyUrl = await window.ghost.getProxyUrl();
  statusEl.textContent = `proxy: ${proxyUrl}`;
  const hint = document.getElementById('proxyhint');
  if (hint) hint.textContent = proxyUrl;

  window.ghost.onNewTab((url) => {
    createTab(url);
  });

  createTab();
})();
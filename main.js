const { app, BrowserWindow, Menu, ipcMain, shell, clipboard, session, dialog } = require('electron');
const path = require('path'), fs = require('fs');
const AdmZip = require('adm-zip'), crxOffset = require('./crx');

const U = app.getPath('userData');
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const write = (f, v) => fs.writeFile(f, JSON.stringify(v), () => {});

// ---- profiles: each has its own session (cookies, cache), data file, settings and extensions ----
const metaFile = path.join(U, 'profiles.json');
let meta = read(metaFile) || { profiles: [{ id: 'default', name: 'Person 1', color: '#9b6bff' }], last: 'default' };
const saveMeta = () => write(metaFile, meta);
const dbs = {};
const dbFile = id => path.join(U, id === 'default' ? 'amethyst.json' : `profile-${id}.json`); // 'default' keeps your existing data
const db = id => dbs[id] || (dbs[id] = read(dbFile(id)) || {});
const saveDb = id => write(dbFile(id), db(id));
const cfgOf = id => db(id).cfg || {};
const sessionFor = id => id === 'default' ? session.defaultSession : session.fromPartition('persist:p-' + id);
const prof = e => (BrowserWindow.fromWebContents(e.sender) || {}).profile || 'default';
const sesProfile = new WeakMap();

ipcMain.handle('db:get', (e, k) => db(prof(e))[k]);
ipcMain.on('db:set', (e, k, v) => { const p = prof(e); db(p)[k] = v; saveDb(p); });
ipcMain.handle('prof:list', () => meta);
ipcMain.on('prof:open', (_, id) => { meta.last = id; saveMeta(); createWindow(false, id); });
ipcMain.handle('prof:add', (_, name, color) => { const id = Date.now().toString(36); meta.profiles.push({ id, name, color }); saveMeta(); return id; });
ipcMain.handle('prof:edit', (_, id, name) => { const p = meta.profiles.find(p => p.id === id); if (p) p.name = name; saveMeta(); return meta; });
ipcMain.handle('prof:del', async (_, id) => {
  if (meta.profiles.length < 2) return meta;
  meta.profiles = meta.profiles.filter(p => p.id !== id);
  if (meta.last === id) meta.last = meta.profiles[0].id;
  saveMeta();
  if (![...wins].some(w => w.profile !== id)) await createWindow(false, meta.profiles[0].id);
  [...wins].filter(w => w.profile === id).forEach(w => w.close());
  try { await sessionFor(id).clearStorageData(); } catch {}
  fs.rm(dbFile(id), { force: true }, () => {}); delete dbs[id];
  fs.rm(path.join(U, 'extensions', id), { recursive: true, force: true }, () => {});
  return meta;
});

// ---- extensions (Chrome extensions, loaded into the profile's session) ----
const extApi = id => { const s = sessionFor(id); return s.extensions || s; };
const extLoaded = new Set();
async function loadExts(id) {
  if (extLoaded.has(id)) return; extLoaded.add(id);
  for (const x of db(id).exts || []) { try { await extApi(id).loadExtension(x.dir, { allowFileAccess: true }); } catch (err) { console.error('extension:', err.message); } }
}
async function addExt(p, dir) {
  const ext = await extApi(p).loadExtension(dir, { allowFileAccess: true });
  const list = (db(p).exts || []).filter(x => x.dir !== dir);
  list.push({ dir, id: ext.id, name: ext.name, version: ext.version });
  db(p).exts = list; saveDb(p); return list;
}
ipcMain.handle('ext:list', e => db(prof(e)).exts || []);
ipcMain.handle('ext:load', async e => {
  const p = prof(e), r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory'], title: 'Select an unpacked extension folder' });
  if (r.canceled) return { list: db(p).exts || [] };
  try { return { list: await addExt(p, r.filePaths[0]) }; } catch (err) { return { error: err.message, list: db(p).exts || [] }; }
});
ipcMain.handle('ext:install', async (e, input) => {
  const p = prof(e), m = /[a-p]{32}/.exec(input || '');
  if (!m) return { error: 'Paste a Chrome Web Store link or a 32-letter extension ID.', list: db(p).exts || [] };
  try {
    const url = 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0.0.0&acceptformat=crx2,crx3&x=' + encodeURIComponent('id=' + m[0] + '&uc');
    const res = await fetch(url); if (!res.ok) throw new Error('Chrome Web Store returned ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer()), dir = path.join(U, 'extensions', p, m[0]);
    new AdmZip(buf.subarray(crxOffset(buf))).extractAllTo(dir, true);
    return { list: await addExt(p, dir) };
  } catch (err) { return { error: err.message, list: db(p).exts || [] }; }
});
ipcMain.handle('ext:remove', async (e, id) => {
  const p = prof(e), x = (db(p).exts || []).find(x => x.id === id);
  try { await extApi(p).removeExtension(id); } catch {}
  db(p).exts = (db(p).exts || []).filter(x => x.id !== id); saveDb(p);
  if (x && x.dir.startsWith(path.join(U, 'extensions'))) fs.rm(x.dir, { recursive: true, force: true }, () => {});
  return db(p).exts;
});

// ---- privacy settings actions ----
ipcMain.handle('clear', async (e, what) => {
  const s = sessionFor(prof(e));
  if (what.includes('cookies')) await s.clearStorageData();
  if (what.includes('cache')) await s.clearCache();
});
ipcMain.handle('pick:dir', async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---- ad & tracker shield ----
const TRACKERS = ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagservices.com',
  'google-analytics.com', 'googletagmanager.com', 'adservice.google.com', 'connect.facebook.net', 'scorecardresearch.com',
  'adnxs.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net', 'hotjar.com', 'amazon-adsystem.com',
  'moatads.com', 'rubiconproject.com', 'pubmatic.com', 'ads-twitter.com', 'quantserve.com', 'adsrvr.org', 'mixpanel.com'];
const isTracker = u => { try { const h = new URL(u).hostname; return TRACKERS.some(d => h === d || h.endsWith('.' + d)); } catch { return false; } };

const SUGGEST = { DuckDuckGo: 'https://duckduckgo.com/ac/?type=list&q=', Google: 'https://suggestqueries.google.com/complete/search?client=firefox&q=',
  Brave: 'https://search.brave.com/api/suggest?q=', Bing: 'https://api.bing.com/osjson.aspx?query=' };
ipcMain.handle('suggest', async (_, engine, q) => {
  try {
    const r = await fetch((SUGGEST[engine] || SUGGEST.DuckDuckGo) + encodeURIComponent(q), { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    return Array.isArray(j[1]) ? j[1].slice(0, 6).map(String) : [];
  } catch { return []; }
});

const wins = new Set();
const broadcast = (id, ch, ...a) => wins.forEach(w => w.profile === id && w.webContents.send(ch, ...a));
const uniq = (dir, name) => {
  const ext = path.extname(name), base = path.basename(name, ext); let p = path.join(dir, name), i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${i++})${ext}`);
  return p;
};
const SAFE_PERMS = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock'];

// Applies to every session (every profile + private)
app.on('session-created', ses => {
  const P = () => sesProfile.get(ses) || 'default';
  ses.setUserAgent(ses.getUserAgent().replace(/\s*(Electron|amethyst)\/\S+/gi, ''));
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
    const c = cfgOf(P());
    if (c.shield !== false && isTracker(d.url)) { broadcast(P(), 'blocked'); return cb({ cancel: true }); }
    if (c.httpsOnly && d.url.startsWith('http://') && !/^http:\/\/(localhost|127\.|\[::1\]|192\.168\.|10\.)/.test(d.url)) return cb({ redirectURL: 'https://' + d.url.slice(7) });
    cb({});
  });
  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    if (cfgOf(P()).dnt) { d.requestHeaders['DNT'] = '1'; d.requestHeaders['Sec-GPC'] = '1'; }
    cb({ requestHeaders: d.requestHeaders });
  });
  ses.setPermissionRequestHandler((wc, perm, cb, det) => {
    if (SAFE_PERMS.includes(perm)) return cb(true);
    const p = P(), mode = cfgOf(p).perm || 'ask';
    if (mode === 'block') return cb(false);
    if (mode === 'allow') return cb(true);
    let origin = ''; try { origin = new URL(det.requestingUrl).origin; } catch {}
    const perms = db(p).perms || (db(p).perms = {}), k = origin + '|' + perm;
    if (perms[k] !== undefined) return cb(perms[k]);
    const opts = { type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1, message: `${origin || 'This site'} wants permission: ${perm}` };
    const w = BrowserWindow.fromWebContents(wc.hostWebContents || wc);
    (w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts)).then(r => { perms[k] = r.response === 0; saveDb(p); cb(r.response === 0); });
  });
  ses.on('will-download', (_, item) => {
    const c = cfgOf(P()), id = Date.now() + Math.random();
    if (!c.askDl) item.setSavePath(uniq(c.dlDir && fs.existsSync(c.dlDir) ? c.dlDir : app.getPath('downloads'), item.getFilename()));
    const send = state => broadcast(P(), 'download', { id, name: item.getFilename(), path: item.getSavePath(), got: item.getReceivedBytes(), total: item.getTotalBytes(), state });
    send('progressing');
    item.on('updated', (_, s) => send(s));
    item.once('done', (_, s) => send(s));
  });
});

// ---- windows ----
async function createWindow(priv, id) {
  if (!priv) await loadExts(id);
  const win = new BrowserWindow({
    width: 1000, height: 680, minWidth: 420, minHeight: 300,
    title: priv ? 'Amethyst — Private' : 'Amethyst',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: priv ? '#0a0211' : '#392746',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden', // custom title bar: tabs live in the title bar like Chrome
    trafficLightPosition: { x: 12, y: 12 },
    ...(process.platform !== 'darwin' ? { titleBarOverlay: { color: priv ? '#0a0211' : '#392746', symbolColor: '#efeaff', height: 38 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), webviewTag: true, contextIsolation: true, sandbox: true }
  });
  win.profile = id;
  win.setMenuBarVisibility(false);
  wins.add(win); win.on('closed', () => wins.delete(win));
  win.loadFile(path.join(__dirname, 'index.html'), { search: `profile=${id}` + (priv ? '&private=1' : '') });
}
ipcMain.on('win:new', (e, priv) => createWindow(!!priv, prof(e)));
ipcMain.on('win:close', e => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
ipcMain.on('win:fs', e => { const w = BrowserWindow.fromWebContents(e.sender); w.setFullScreen(!w.isFullScreen()); });
ipcMain.on('item:show', (_, p) => shell.showItemInFolder(p));
ipcMain.on('win:overlay', (e, color, symbolColor) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  try { if (w && w.setTitleBarOverlay) w.setTitleBarOverlay({ color, symbolColor, height: 38 }); } catch {}
});

const KEYS = new Set(['t', 'w', 'l', 'r', 'f', 'h', 'j', 'd', 'p', 'n', '0', '-', '=', '+', 'tab', 'f11', 'f12']);

app.on('web-contents-created', (_, wc) => {
  const host = wc.hostWebContents || wc;
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown' || !/^file:/.test(host.getURL())) return;
    const k = i.key.toLowerCase();
    if (KEYS.has(k) && (i.control || i.meta || k.startsWith('f1'))) {
      e.preventDefault();
      host.send('shortcut', (i.shift ? 'S+' : '') + k);
    }
  });
  if (wc.getType() !== 'webview') return;
  const hw = BrowserWindow.fromWebContents(host); if (hw) sesProfile.set(wc.session, hw.profile);
  wc.setWindowOpenHandler(({ url }) => { host.send('open-tab', url); return { action: 'deny' }; });
  wc.on('context-menu', (_, p) => {
    const h = wc.navigationHistory, t = [];
    if (p.linkURL) t.push({ label: 'Open link in new tab', click: () => host.send('open-tab', p.linkURL) },
      { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
    if (p.hasImageContents) t.push({ label: 'Save image', click: () => wc.downloadURL(p.srcURL) }, { type: 'separator' });
    if (p.selectionText) t.push({ role: 'copy' });
    if (p.isEditable) t.push({ role: 'paste' });
    t.push({ label: 'Back', enabled: h.canGoBack(), click: () => h.goBack() },
      { label: 'Forward', enabled: h.canGoForward(), click: () => h.goForward() },
      { label: 'Reload', click: () => wc.reload() }, { type: 'separator' },
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(t).popup();
  });
});

app.whenReady().then(() => createWindow(false, meta.profiles.some(p => p.id === meta.last) ? meta.last : meta.profiles[0].id));
app.on('window-all-closed', () => app.quit());

const { contextBridge, ipcRenderer: ipc } = require('electron');
const on = ch => f => ipc.on(ch, (_, ...a) => f(...a));
const call = ch => (...a) => ipc.invoke(ch, ...a);
contextBridge.exposeInMainWorld('amethyst', {
  get: k => ipc.invoke('db:get', k), set: (k, v) => ipc.send('db:set', k, v),
  onOpenTab: on('open-tab'), onShortcut: on('shortcut'), onBlocked: on('blocked'), onDownload: on('download'),
  shield: () => {}, suggest: call('suggest'), newWindow: p => ipc.send('win:new', p),
  fullscreen: () => ipc.send('win:fs'), closeWindow: () => ipc.send('win:close'), overlay: (c, s) => ipc.send('win:overlay', c, s), show: p => ipc.send('item:show', p),
  profiles: call('prof:list'), openProfile: id => ipc.send('prof:open', id), addProfile: call('prof:add'),
  editProfile: call('prof:edit'), delProfile: call('prof:del'),
  extList: call('ext:list'), extLoad: call('ext:load'), extInstall: call('ext:install'), extRemove: call('ext:remove'),
  clear: call('clear'), pickDir: call('pick:dir')
});

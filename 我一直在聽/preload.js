const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('api', {
  getSettings:      ()      => ipcRenderer.invoke('get-settings'),
  saveSettings:     (s)     => ipcRenderer.invoke('save-settings', s),
  getConfig:        ()      => ipcRenderer.invoke('get-config'),
  saveConfig:       (c)     => ipcRenderer.invoke('save-config', c),
  getOverlayUrl:    ()      => ipcRenderer.invoke('get-overlay-url'),
  getCurrentTrack:  ()      => ipcRenderer.invoke('get-current-track'),
  setManualTrack:   (t)     => ipcRenderer.invoke('set-manual-track', t),
  loadPlayerUrl:    (url)   => ipcRenderer.invoke('load-player-url', url),
  showPlayer:       (show)  => ipcRenderer.invoke('show-player', show),
  setPlayerOffset:  (y)     => ipcRenderer.invoke('set-player-offset', y),
  playerBack:       ()      => ipcRenderer.invoke('player-back'),
  playerRefresh:    ()      => ipcRenderer.invoke('player-refresh'),
  importFont: () => ipcRenderer.invoke('import-font'),
  removeFont: () => ipcRenderer.invoke('remove-font'),
  onTrackUpdate:    (cb)    => ipcRenderer.on('track-update', (_, d) => cb(d)),
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  getIpWhitelist: () => ipcRenderer.invoke('get-ip-whitelist'),
  setIpWhitelist: (list) => ipcRenderer.invoke('set-ip-whitelist', list)
})

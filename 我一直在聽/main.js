const { app, BrowserWindow, BrowserView, ipcMain, Tray, Menu, nativeImage, shell, dialog } = require('electron')
const path = require('path')
const http = require('http')
const fs = require('fs')
const Store = require('electron-store')

const store = new Store()
let mainWindow    = null
let tray          = null
let overlayServer = null
let currentTrack  = null
let playerViews   = {}   // { url: BrowserView }
let activePlayerKey = null
let playerPollInterval = null
let playerVisible = false

// ══════════════════════════════════════════════════════════════════
//  第一部分：本機 HTTP 伺服器
// ══════════════════════════════════════════════════════════════════

function startOverlayServer() {
  const port = store.get('port', 3456)
  const apiKey = store.get('apiKey') || (() => {
  const key = require('crypto').randomBytes(16).toString('hex')
  store.set('apiKey', key)
  return key
})()

  overlayServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    const checkKey = (req) => {
      const token = req.headers['x-api-key'] || new URL(req.url, 'http://localhost').searchParams.get('key')
      return token === apiKey
    }
    const checkIp = (req) => {
      const clientIp = req.socket.remoteAddress?.replace('::ffff:', '') || ''
      const whitelist = store.get('ipWhitelist', ['127.0.0.1', '::1'])
      return whitelist.includes(clientIp)
    }

    if (!checkIp(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: 'Forbidden' }))
      return
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(path.join(__dirname, 'overlay.html')))

    } else if (url.pathname === '/track') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' })
      res.end(JSON.stringify(currentTrack || { playing: false }))

    } else if (url.pathname === '/settings') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(store.get('settings', defaultSettings())))

    } else if (url.pathname === '/customfont') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(store.get('customFont', null)))

    } else if (url.pathname === '/extension-track' && req.method === 'OPTIONS') {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' })
      res.end()

    } else if (url.pathname === '/extension-track' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        try {
          const track = JSON.parse(body)
          if (track && track.song && !currentTrack?.fromPlayerView) {
            currentTrack = track
            mainWindow?.webContents.send('track-update', currentTrack)
            updateTrayMenu()
          }
        } catch(e) {}
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end('ok')
      })

      } else if (url.pathname === '/set-track' && req.method === 'POST') {
        if (!checkKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      let body = ''
      req.on('data', chunk => body += chunk)
      req.on('end', () => {
        try {
          const track = JSON.parse(body)
          if (track && track.song) {
            currentTrack = { ...track, playing: true, source: track.source || '外部' }
            mainWindow?.webContents.send('track-update', currentTrack)
            updateTrayMenu()
          }
        } catch(e) {}
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ ok: true }))
      })

    } else if (url.pathname === '/clear' && req.method === 'POST') {
      if (!checkKey(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
      currentTrack = { playing: false }
      mainWindow?.webContents.send('track-update', currentTrack)
      updateTrayMenu()
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok: true }))

    } else if (url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        playing: currentTrack?.playing || false,
        song:    currentTrack?.song    || null,
        artist:  currentTrack?.artist  || null,
        source:  currentTrack?.source  || null,
        albumArt: currentTrack?.albumArt || null
      }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  overlayServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const newPort = port + 1
      store.set('port', newPort)
      overlayServer.listen(newPort, '0.0.0.0')
    }
  })

  overlayServer.listen(port, '0.0.0.0')
}


// ══════════════════════════════════════════════════════════════════
//  第二部分：內嵌瀏覽器偵測（BrowserView）
//
//  在 Electron 內嵌一個 Chromium 視窗，直接讀 mediaSession API
//  支援 Spotify Web、YouTube Music、YouTube 等所有有 mediaSession 的網站
//  朋友只需要在 APP 裡登入一次，不需要任何額外安裝
// ══════════════════════════════════════════════════════════════════

// 取得或建立指定服務的 BrowserView（每個服務各自一個，保持登入狀態）
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function getOrCreateView(key) {
  if (playerViews[key]) return playerViews[key]

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:player_' + key.replace(/[^a-z0-9]/gi, '_')
    }
  })
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
  mainWindow.addBrowserView(view)
  view.webContents.session.setUserAgent(CHROME_UA)
  view.webContents.loadURL(key)
  playerViews[key] = view
  return view
}

function createPlayerView() {
  // 預先建立上次使用的服務（如果有的話）
  const savedKey = store.get('playerUrl')
  if (savedKey) {
    getOrCreateView(savedKey)
    activePlayerKey = savedKey
    startPlayerPolling()
  }
}

function loadPlayerUrl(url) {
  // 切換到指定服務，如果沒有就建立新的
  activePlayerKey = url
  store.set('playerUrl', url)
  getOrCreateView(url)
  if (playerVisible) showPlayerView(true)  // 如果瀏覽器目前可見，切換顯示
  startPlayerPolling()
}

let playerYOffset = 80  // 預設，BrowserView 從 tabs 下方開始

// 切換顯示 / 隱藏內嵌瀏覽器（只顯示 activePlayerKey 那個）
function showPlayerView(show) {
  if (!mainWindow) return
  playerVisible = show
  const [w, h] = mainWindow.getContentSize()
  Object.values(playerViews).forEach(v => v.setBounds({ x: 0, y: 0, width: 1, height: 1 }))
  if (show && activePlayerKey && playerViews[activePlayerKey]) {
    playerViews[activePlayerKey].setBounds({
      x: 240,
      y: playerYOffset,
      width: w - 240,
      height: h - playerYOffset
    })
  }
}

function startPlayerPolling() {
  if (playerPollInterval) clearInterval(playerPollInterval)
  pollPlayerView()
  playerPollInterval = setInterval(pollPlayerView, 2000)
}

const READ_MEDIA_JS = `(function() {
  const ms = navigator.mediaSession
  if (!ms || !ms.metadata || !ms.metadata.title) return null
  const video = document.querySelector('video')
  const isPlaying = ms.playbackState === 'playing' ||
    (ms.playbackState !== 'paused' && video && !video.paused)
  const artwork = ms.metadata.artwork
  const albumArt = artwork && artwork.length > 0 ? artwork[artwork.length - 1].src : null
  const host = location.hostname
  const source = host.includes('music.youtube') ? 'YouTube Music'
    : host.includes('youtube') ? 'YouTube'
    : host.includes('spotify') ? 'Spotify'
    : host.includes('tidal') ? 'Tidal'
    : host.includes('deezer') ? 'Deezer'
    : host.includes('soundcloud') ? 'SoundCloud'
    : host
  return { playing: isPlaying, song: ms.metadata.title, artist: ms.metadata.artist || '', albumArt, source }
})()`

async function pollPlayerView() {
  let found = null
  // 輪詢所有已建立的 view，找出正在播放的那個
  for (const view of Object.values(playerViews)) {
    try {
      const result = await view.webContents.executeJavaScript(READ_MEDIA_JS)
      if (result && result.song && result.playing) {
        found = result
        break  // 找到正在播放的就停
      } else if (result && result.song && !found) {
        found = result  // 暫停中的當備用
      }
    } catch(e) {}
  }

  if (!found || !found.song) {
    if (currentTrack?.fromPlayerView) {
      currentTrack = { playing: false }
      mainWindow?.webContents.send('track-update', currentTrack)
      updateTrayMenu()
    }
    return
  }

  const track = { ...found, fromPlayerView: true }
  if (currentTrack?.song !== track.song ||
      currentTrack?.artist !== track.artist ||
      currentTrack?.playing !== track.playing) {
    currentTrack = track
    mainWindow?.webContents.send('track-update', currentTrack)
    updateTrayMenu()
  }
}

// ══════════════════════════════════════════════════════════════════
//  第三部分：外觀設定預設值
// ══════════════════════════════════════════════════════════════════

function defaultSettings() {
  return {
    accentColor: '#7c5af0', textColor: '#ffffff', cardBg: '#0f0f14',
    opacity: 88, borderRadius: 14, font: 'system-ui', scale: 100,
    showAlbum: true, showProgress: true, showEq: true,
    marquee: false, position: 'bottom-left', padding: 24, autoHide: true
  }
}

// ══════════════════════════════════════════════════════════════════
//  第四部分：視窗 / 系統匣
// ══════════════════════════════════════════════════════════════════

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 960, height: 660, minWidth: 800, minHeight: 560,
    title: 'NowPlaying', backgroundColor: '#0f0f13',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  mainWindow.loadFile('index.html')
  mainWindow.on('close', e => { app.isQuiting = true; app.quit() })
  mainWindow.on('resize', () => {
    // 如果內嵌瀏覽器正在顯示，跟著視窗大小調整
    const [w, h] = mainWindow.getContentSize()
    if (activePlayerKey && playerViews[activePlayerKey]) {
      if (playerVisible) showPlayerView(true)
    }
  })
}

function updateTrayMenu() {
  if (!tray) return
  const label = currentTrack?.playing ? `♪  ${currentTrack.song} — ${currentTrack.artist}` : '未播放'
  const port  = store.get('port', 3456)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: '顯示 APP', click: () => mainWindow?.show() },
    { label: `OBS URL: http://127.0.0.1:${port}/`, enabled: false },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuiting = true; app.quit() } }
  ]))
}

function createTray() {
  let icon
  try { icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.png')) }
  catch(e) { icon = nativeImage.createEmpty() }
  tray = new Tray(icon)
  tray.setToolTip('NowPlaying')
  tray.on('click', () => mainWindow?.show())
  updateTrayMenu()
}

// ══════════════════════════════════════════════════════════════════
//  第五部分：IPC
// ══════════════════════════════════════════════════════════════════

ipcMain.handle('get-settings',     ()    => store.get('settings', defaultSettings()))
ipcMain.handle('save-settings',    (_, s) => { store.set('settings', s); return true })
ipcMain.handle('get-config', () => ({ port: store.get('port', 3456), playerUrl: store.get('playerUrl', ''), customFont: store.get('customFont', null) }))
ipcMain.handle('save-config',      (_, c) => { if (c.port) store.set('port', c.port); return true })
ipcMain.handle('get-api-key', () => store.get('apiKey', ''))
ipcMain.handle('get-ip-whitelist', () => store.get('ipWhitelist', ['127.0.0.1', '::1']))
ipcMain.handle('set-ip-whitelist', (_, list) => { store.set('ipWhitelist', list); return true })
ipcMain.handle('get-overlay-url', () => {
  const port = store.get('port', 3456)
  const { networkInterfaces } = require('os')
  const nets = networkInterfaces()
  let localIp = '127.0.0.1'
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIp = net.address
        break
      }
    }
  }
  return `http://${localIp}:${port}/`
})
ipcMain.handle('get-current-track',()    => currentTrack || { playing: false })
ipcMain.handle('set-manual-track', (_, t) => {
  currentTrack = { ...t, playing: !!t.song, source: '手動' }
  mainWindow?.webContents.send('track-update', currentTrack)
  updateTrayMenu()
  return true
})

// 載入音樂服務網址到內嵌瀏覽器
ipcMain.handle('load-player-url', (_, url) => {
  loadPlayerUrl(url)
  return true
})

// 切換顯示 / 隱藏內嵌瀏覽器
ipcMain.handle('show-player', (_, show) => { showPlayerView(show); return true })
ipcMain.handle('set-player-offset', (_, yOffset) => {
  playerYOffset = yOffset
  if (playerVisible) showPlayerView(true)  // 立即用新 offset 重新定位
  return true
})

// 讓使用者在內嵌瀏覽器裡可以返回 / 重新整理
ipcMain.handle('player-back',    () => { if (activePlayerKey) playerViews[activePlayerKey]?.webContents.goBack();    return true })
ipcMain.handle('player-refresh', () => { if (activePlayerKey) playerViews[activePlayerKey]?.webContents.reload();    return true })
ipcMain.handle('player-home',    (_, url) => { if (activePlayerKey) playerViews[activePlayerKey]?.webContents.loadURL(url); return true })
ipcMain.handle('import-font', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '選擇字體檔案',
    filters: [{ name: '字體檔案', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
    properties: ['openFile']
  })
  if (canceled || !filePaths[0]) return null

  const fontPath = filePaths[0]
  const fontName = path.basename(fontPath)
  const fontData = fs.readFileSync(fontPath)
  const ext = path.extname(fontPath).toLowerCase().slice(1)
  const mimeMap = { ttf: 'font/truetype', otf: 'font/opentype', woff: 'font/woff', woff2: 'font/woff2' }
  const dataUrl = `data:${mimeMap[ext]};base64,` + fontData.toString('base64')

  store.set('customFont', { name: fontName, dataUrl })
  return { name: fontName, dataUrl }
})

ipcMain.handle('remove-font', () => {
  store.delete('customFont')
  return true
})

// ══════════════════════════════════════════════════════════════════
//  第六部分：APP 生命週期
// ══════════════════════════════════════════════════════════════════

app.whenReady().then(() => {
  createMainWindow()
  createTray()
  startOverlayServer()
  createPlayerView()
  checkForUpdates()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (mainWindow === null) createMainWindow(); else mainWindow.show() })
app.on('before-quit', () => { app.isQuiting = true; overlayServer?.close() })

async function checkForUpdates() {
  try {
    const { net } = require('electron')
    const currentVersion = require('./package.json').version
    const res = await fetch('https://gist.githubusercontent.com/urad1work-coder/750e0a1570da64160986e7966bc2708f/raw/version.json')
    const data = await res.json()
    
    if (data.version !== currentVersion) {
      const { dialog } = require('electron')
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '有新版本',
        message: `新版本 ${data.version} 已發布`,
        detail: data.notes || '建議更新到最新版本',
        buttons: ['稍後再說', '了解'],
      })
    }
  } catch(e) {}
}
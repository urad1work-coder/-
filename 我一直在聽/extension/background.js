// background.js — 擴充功能背景 service worker
// 接收 content.js 傳來的歌曲資料，POST 給 Electron APP

const APP_URL = 'http://127.0.0.1:3456/extension-track'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'TRACK_UPDATE') return

  fetch(APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message.track)
  })
  .then(() => sendResponse({ ok: true }))
  .catch(() => sendResponse({ ok: false }))

  return true  // 非同步回應
})

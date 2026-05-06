// content.js — 注入到 YouTube / YouTube Music 頁面
// 偵測到歌曲變化時傳給 background.js

const isYTMusic = location.hostname === 'music.youtube.com'
const isYouTube = location.hostname === 'www.youtube.com'

let lastKey = ''  // 上次傳送的「歌名|歌手」，用來避免重複傳送

// ─── YouTube Music 讀取 ───────────────────────────────────────────
function getYTMusicTrack() {
  try {
    const songEl = document.querySelector('.ytmusic-player-bar .title.ytmusic-player-bar')
               ?? document.querySelector('ytmusic-player-bar .title')
    const artistEl = document.querySelector('.ytmusic-player-bar .byline.ytmusic-player-bar')
                  ?? document.querySelector('ytmusic-player-bar .byline')
    const artEl = document.querySelector('ytmusic-player-bar #thumbnail img')

    // 播放狀態：用 video 元素判斷，最準確
    const video = document.querySelector('video')
    const isPlaying = video ? !video.paused && !video.ended : false

    const song = songEl?.textContent?.trim()
    if (!song) return null

    // artist 欄位裡可能包含 "歌手 • 專輯 • 年份"，只取第一段
    const artistRaw = artistEl?.textContent?.trim() || ''
    const artist = artistRaw.split('•')[0].trim()

    return {
      playing: isPlaying,
      source: 'YouTube Music',
      song,
      artist: artist || 'YouTube Music',
      albumArt: artEl?.src || null
    }
  } catch(e) { return null }
}

// ─── YouTube 讀取 ─────────────────────────────────────────────────
function getYouTubeTrack() {
  try {
    // 只在影片頁面偵測
    if (!location.pathname.startsWith('/watch')) return null

    const titleEl = document.querySelector('#above-the-fold #title h1 yt-formatted-string')
                 ?? document.querySelector('#title h1 yt-formatted-string')
                 ?? document.querySelector('h1.ytd-video-primary-info-renderer')
    const channelEl = document.querySelector('#channel-name #text a')
                   ?? document.querySelector('#channel-name #text')

    const videoId = new URLSearchParams(location.search).get('v')
    const albumArt = videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null

    const video = document.querySelector('video.html5-main-video') ?? document.querySelector('video')
    const isPlaying = video ? !video.paused && !video.ended : false

    const song = titleEl?.textContent?.trim()
    if (!song) return null

    return {
      playing: isPlaying,
      source: 'YouTube',
      song,
      artist: channelEl?.textContent?.trim() || 'YouTube',
      albumArt
    }
  } catch(e) { return null }
}

// ─── 主偵測與傳送 ──────────────────────────────────────────────────
let _dead = false  // 擴充功能 context 失效旗標

function safeMessage(msg) {
  if (_dead) return
  try {
    chrome.runtime.sendMessage(msg, () => {
      // 偵測到 context 失效（擴充功能被更新/重載）→ 設旗標停止後續傳送
      if (chrome.runtime.lastError) _dead = true
    })
  } catch(e) {
    _dead = true
  }
}

function checkAndSend() {
  if (_dead) return
  const track = isYTMusic ? getYTMusicTrack() : (isYouTube ? getYouTubeTrack() : null)
  if (!track || !track.song) return

  const key = track.song + '|' + track.artist + '|' + track.playing
  if (key === lastKey) return  // 沒有變化，不傳
  lastKey = key

  safeMessage({ type: 'TRACK_UPDATE', track })
}

// ─── 啟動偵測 ─────────────────────────────────────────────────────
setTimeout(() => {
  checkAndSend()
  setInterval(() => { if (!_dead) checkAndSend() }, 1000)
}, 1500)

// 監聽 <title> 變化（YouTube 換歌時 title 立刻變）
const titleTarget = document.querySelector('title') || document.head
new MutationObserver(() => {
  if (!_dead) setTimeout(checkAndSend, 500)
}).observe(titleTarget, { subtree: true, childList: true, characterData: true })

// 監聽 YouTube SPA 頁面切換
document.addEventListener('yt-navigate-finish', () => {
  lastKey = ''
  setTimeout(checkAndSend, 1500)
})

// 監聽 video 播放/暫停
function attachVideoListeners() {
  const video = document.querySelector('video')
  if (!video) return
  video.addEventListener('play',  () => { if (!_dead) checkAndSend() })
  video.addEventListener('pause', () => { if (!_dead) checkAndSend() })
}
setTimeout(attachVideoListeners, 2000)
document.addEventListener('yt-navigate-finish', () => setTimeout(attachVideoListeners, 2000))

// 回應 popup 查詢
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TRACK') {
    const track = isYTMusic ? getYTMusicTrack() : (isYouTube ? getYouTubeTrack() : null)
    sendResponse({ track })
  }
  return true
})

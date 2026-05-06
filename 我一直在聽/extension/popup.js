// popup.js — 擴充功能彈出視窗的邏輯

const dot = document.getElementById('connDot')
const connText = document.getElementById('connText')
const wrap = document.getElementById('trackWrap')

async function init() {
  // 確認 APP 是否在線
  try {
    const r = await fetch('http://127.0.0.1:3456/track', { signal: AbortSignal.timeout(2000) })
    const data = await r.json()
    dot.classList.add('ok')
    connText.textContent = 'NowPlaying APP 已連線'
    showTrack(data)
  } catch(e) {
    dot.classList.add('err')
    connText.textContent = 'APP 未開啟'
    wrap.replaceChildren()
  }
}

function showTrack(t) {
  wrap.replaceChildren()
  if (!t || !t.song) {
    const p = document.createElement('div')
    p.className = 'empty'
    p.textContent = '目前沒有播放音樂'
    wrap.appendChild(p)
    return
  }
  const div = document.createElement('div')
  div.className = 'track'
  const src = document.createElement('div')
  src.className = 'track-source'
  src.textContent = t.source || '未知'
  const song = document.createElement('div')
  song.className = 'track-song'
  song.textContent = t.song
  const artist = document.createElement('div')
  artist.className = 'track-artist'
  artist.textContent = t.artist
  div.appendChild(src)
  div.appendChild(song)
  div.appendChild(artist)
  wrap.appendChild(div)
}

init()

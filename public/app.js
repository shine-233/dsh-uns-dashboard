const SERIES_COLORS = ['#ffb454', '#56c8de', '#4fc98e']
const MAX_POINTS = 300

const state = {
  provider: 'mock',
  tree: [],
  pinned: [],
  active: null,
  buffers: new Map(),
  live: true,
  windowMs: 300000,
  es: null,
}

const $ = (id) => document.getElementById(id)

function toast(message, isError = false) {
  const box = document.createElement('div')
  box.className = `toast${isError ? ' err' : ''}`
  box.textContent = message
  $('toasts').appendChild(box)
  setTimeout(() => {
    box.classList.add('out')
    setTimeout(() => box.remove(), 350)
  }, 3200)
}

function logEvent(path, value, isError = false) {
  const li = document.createElement('li')
  if (isError) li.className = 'err'
  const time = document.createElement('time')
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const p = document.createElement('span')
  p.className = 'p'
  p.textContent = path
  const v = document.createElement('span')
  v.className = 'v'
  v.textContent = String(value).slice(0, 24)
  li.append(time, p, v)
  const list = $('log')
  list.prepend(li)
  while (list.children.length > 80) list.lastChild.remove()
}

function startClock() {
  const tick = () => {
    $('clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  }
  tick()
  setInterval(tick, 1000)
}

async function initConfig() {
  try {
    const config = await fetch('/api/config').then((r) => r.json())
    state.provider = config.active
    $('provider-pill').textContent = config.active
    setConn(true, `已连接 · ${config.active}`)
  } catch {
    setConn(false, '后端不可达')
  }
}

function setConn(ok, text) {
  const led = $('conn-led')
  led.classList.toggle('is-ok', ok)
  led.classList.toggle('is-err', !ok)
  $('conn-text').textContent = text
}

function renderTree(nodes, parentEl, depth) {
  for (const node of nodes) {
    const li = document.createElement('li')
    li.className = 'tree-node'
    li.dataset.path = node.path
    const row = document.createElement('div')
    row.className = 'row'
    row.setAttribute('role', node.kind === 'file' ? 'button' : 'treeitem')
    row.tabIndex = 0
    if (node.kind === 'file') {
      li.classList.add('tree-file')
      row.innerHTML = `<span class="caret">·</span><span class="node-name">${node.path.split('/').pop()}</span><span class="node-kind">${node.unit ?? ''}</span>`
      const activate = () => togglePin(node, li)
      row.addEventListener('click', activate)
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') activate()
      })
    } else {
      li.classList.add('open')
      row.innerHTML = `<span class="caret">▶</span><span class="node-name">${node.path.split('/').pop() || 'UNS'}</span><span class="node-kind">${(node.children?.length ?? 0) || ''}</span>`
      row.addEventListener('click', () => li.classList.toggle('open'))
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') li.classList.toggle('open')
      })
    }
    li.appendChild(row)
    if (node.children?.length) {
      const wrap = document.createElement('div')
      wrap.className = 'children-wrap'
      const ul = document.createElement('ul')
      renderTree(node.children, ul, depth + 1)
      wrap.appendChild(ul)
      li.appendChild(wrap)
    }
    parentEl.appendChild(li)
  }
}

function applyFilter(keyword) {
  const lower = keyword.trim().toLowerCase()
  document.querySelectorAll('.tree-node').forEach((li) => {
    const match = !lower || li.dataset.path.toLowerCase().includes(lower)
    li.style.display = match ? '' : 'none'
  })
}

function seriesColor(path) {
  const index = state.pinned.indexOf(path)
  return SERIES_COLORS[index % SERIES_COLORS.length]
}

function togglePin(node, li) {
  const path = node.path
  const at = state.pinned.indexOf(path)
  if (at >= 0) {
    state.pinned.splice(at, 1)
    state.buffers.delete(path)
    li.classList.remove('is-pinned')
    logEvent(path, '移出监视')
  } else {
    if (state.pinned.length >= SERIES_COLORS.length) {
      toast(`最多同时监视 ${SERIES_COLORS.length} 路，请先移除一路`, true)
      return
    }
    state.pinned.push(path)
    state.buffers.set(path, [])
    li.classList.add('is-pinned')
    setActive(path)
    loadHistory(path, 3600000)
    logEvent(path, '加入监视')
  }
  refreshPins()
  restartStream()
}

function setActive(path) {
  state.active = path
  document.querySelectorAll('.tree-node').forEach((li) => {
    li.classList.toggle('is-active', li.dataset.path === path)
  })
  $('write-btn').disabled = !path
  $('write-target').textContent = path
  updateActiveCard(null)
}

function refreshPins() {
  $('series-count').textContent = state.pinned.length ? `${state.pinned.length}/3 路监视` : ''
  $('legend').innerHTML = state.pinned
    .map((path) => `<span><i style="background:${seriesColor(path)}"></i>${path.split('/').pop()}</span>`)
    .join('')
}

async function loadHistory(path, rangeMs) {
  const endMs = Date.now()
  const startMs = endMs - rangeMs
  try {
    const points = await fetch(`/api/history?path=${encodeURIComponent(path)}&startMs=${startMs}&endMs=${endMs}&limit=600`)
      .then((r) => r.json())
    if (!Array.isArray(points)) throw new Error(points.error || '历史数据格式异常')
    state.buffers.set(
      path,
      points.filter((point) => typeof point.value === 'number').map((point) => ({ t: point.timestampMs, v: point.value })),
    )
    logEvent(path, `载入 ${points.length} 点历史`)
  } catch (error) {
    toast(`历史查询失败：${error.message}`, true)
    logEvent(path, error.message, true)
  }
}

async function writeValue(valueText) {
  const path = state.active
  const numeric = Number(valueText)
  const body = { writes: [{ path, value: Number.isFinite(numeric) ? numeric : valueText }] }
  try {
    const result = await fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json())
    if (result.error) throw new Error(result.error)
    toast(`已写入 ${path.split('/').pop()} ← ${valueText}`)
    logEvent(path, `写入 ${valueText}`)
  } catch (error) {
    toast(`写入失败：${error.message}`, true)
    logEvent(path, error.message, true)
  }
}

function updateActiveCard(point) {
  const card = $('tag-card')
  if (!state.active) {
    card.dataset.empty = 'true'
    return
  }
  card.dataset.empty = 'false'
  $('active-path').textContent = state.active
  const buffer = state.buffers.get(state.active) ?? []
  const latest = point ?? buffer.at(-1)
  if (!latest) {
    $('active-value').textContent = '——'
    return
  }
  const element = $('active-value')
  const nextText = String(latest.v)
  if (element.textContent !== nextText) {
    element.textContent = nextText
    element.classList.add('flash')
    setTimeout(() => element.classList.remove('flash'), 260)
  }
  $('active-unit').textContent = latest.unit ?? ''
  $('active-ts').textContent = new Date(latest.t).toLocaleString('zh-CN', { hour12: false })
}

function restartStream() {
  if (state.es) state.es.close()
  if (!state.pinned.length) {
    updateActiveCard(null)
    return
  }
  const query = state.pinned.map((path) => encodeURIComponent(path)).join(',')
  const source = new EventSource(`/api/stream?topics=${query}&provider=${state.provider}`)
  state.es = source
  source.onopen = () => setConn(true, `已连接 · ${state.provider}`)
  source.onerror = () => setConn(false, '流中断，重试中…')
  source.onmessage = (event) => {
    const point = JSON.parse(event.data)
    if (point.path === '__error__') {
      setConn(false, '上游异常')
      logEvent(point.path, point.value, true)
      return
    }
    const buffer = state.buffers.get(point.path)
    if (!buffer) return
    if (typeof point.value !== 'number') return
    buffer.push({ t: point.timestampMs ?? Date.now(), v: point.value })
    if (buffer.length > MAX_POINTS) buffer.shift()
    if (point.path === state.active) updateActiveCard({ t: buffer.at(-1).t, v: buffer.at(-1).v, unit: point.unit })
  }
}

const canvas = $('chart')
const ctx = canvas.getContext('2d')

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  canvas.width = Math.max(rect.width * ratio, 10)
  canvas.height = Math.max(rect.height * ratio, 10)
}
window.addEventListener('resize', resizeCanvas)

function drawChart(nowMs) {
  requestAnimationFrame(drawChart)
  const width = canvas.width
  const height = canvas.height
  if (!width || !height) return
  ctx.clearRect(0, 0, width, height)

  const padL = 52
  const padR = 16
  const padT = 14
  const padB = 26

  let maxT = -Infinity
  for (const [, buffer] of state.buffers) {
    for (const { t } of buffer) maxT = Math.max(maxT, t)
  }
  if (!Number.isFinite(maxT)) {
    ctx.fillStyle = '#6e7a87'
    ctx.font = `${13 * devicePixelRatio}px "IBM Plex Mono", monospace`
    ctx.textAlign = 'center'
    ctx.fillText('在左侧命名空间选择位号开始监视', width / 2, height / 2)
    return
  }
  const minT = Math.max(maxT - state.windowMs, 0)
  let minV = Infinity
  let maxV = -Infinity
  for (const [, buffer] of state.buffers) {
    for (const { t, v } of buffer) {
      if (t < minT) continue
      minV = Math.min(minV, v)
      maxV = Math.max(maxV, v)
    }
  }

  const span = Math.max(maxV - minV, 0.001)
  minV -= span * 0.12
  maxV += span * 0.12
  const spanPad = maxV - minV
  if (maxT - minT < 2000) maxT = minT + 2000

  ctx.strokeStyle = '#232c35'
  ctx.lineWidth = 1
  ctx.font = `${10 * devicePixelRatio}px "IBM Plex Mono", monospace`
  ctx.fillStyle = '#6e7a87'
  ctx.textAlign = 'right'
  for (let i = 0; i <= 4; i += 1) {
    const y = padT + ((height - padT - padB) * i) / 4
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(width - padR, y)
    ctx.stroke()
    const label = (maxV - (spanPad * i) / 4).toFixed(spanPad < 8 ? 2 : 0)
    ctx.fillText(label, padL - 8, y + 3.5 * devicePixelRatio)
  }
  ctx.textAlign = 'center'
  for (let i = 0; i <= 4; i += 1) {
    const x = padL + ((width - padL - padR) * i) / 4
    ctx.beginPath()
    ctx.moveTo(x, padT)
    ctx.lineTo(x, height - padB)
    ctx.stroke()
    const stamp = new Date(minT + ((maxT - minT) * i) / 4)
    ctx.fillText(stamp.toLocaleTimeString('zh-CN', { hour12: false, minute: '2-digit', second: '2-digit' }), x, height - 8)
  }

  const toX = (t) => padL + ((t - minT) / (maxT - minT)) * (width - padL - padR)
  const toY = (v) => padT + (1 - (v - minV) / spanPad) * (height - padT - padB)

  state.pinned.forEach((path, index) => {
    const buffer = state.buffers.get(path) ?? []
    if (buffer.length < 2) return
    const color = SERIES_COLORS[index % SERIES_COLORS.length]
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 2 * devicePixelRatio
    ctx.shadowColor = color
    ctx.shadowBlur = 12 * devicePixelRatio
    ctx.beginPath()
    buffer.forEach((point, i) => {
      const x = toX(point.t)
      const y = toY(point.v)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    ctx.restore()

    const lastPoint = buffer.at(-1)
    const pulse = 3 + Math.sin(nowMs / 300) * 1.2
    ctx.beginPath()
    ctx.arc(toX(lastPoint.t), toY(lastPoint.v), pulse * devicePixelRatio, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = 14 * devicePixelRatio
    ctx.fill()
    ctx.shadowBlur = 0
  })
}

function wireUi() {
  $('tree-filter').addEventListener('input', (event) => applyFilter(event.target.value))
  $('clear-btn').addEventListener('click', () => {
    for (const path of [...state.pinned]) {
      const li = document.querySelector(`.tree-node[data-path="${CSS.escape(path)}"]`)
      if (li) togglePinByPath(path, li)
    }
    toast('已清空全部监视')
  })

  const dialog = $('write-dialog')
  $('write-btn').addEventListener('click', () => {
    if (!state.active) return
    dialog.showModal()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
  $('write-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const input = $('write-input')
    await writeValue(input.value.trim())
    input.value = ''
    dialog.close()
  })

  document.querySelectorAll('.range-btn').forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.active) {
        toast('先选择一个位号', true)
        return
      }
      state.live = false
      state.windowMs = Number(button.dataset.range)
      $('live-btn').classList.remove('is-active')
      button.classList.add('is-active')
      loadHistory(state.active, Number(button.dataset.range))
    })
  })
  $('live-btn').addEventListener('click', () => {
    state.live = true
    state.windowMs = 300000
    document.querySelectorAll('.range-btn').forEach((button) => button.classList.remove('is-active'))
    $('live-btn').classList.add('is-active')
    toast('回到实时流')
  })
}

function togglePinByPath(path, li) {
  togglePin({ path, kind: 'file' }, li)
}

async function boot() {
  startClock()
  wireUi()
  resizeCanvas()
  requestAnimationFrame(drawChart)
  await initConfig()
  try {
    const tree = await fetch('/api/tree?provider=' + state.provider).then((r) => r.json())
    renderTree(tree, $('tree'), 0)
    $('tree-filter').addEventListener('input', (event) => applyFilter(event.target.value))
  } catch (error) {
    toast(`命名空间加载失败：${error.message}`, true)
  }
}

boot()

const now = () => Date.now()

function makeTag(path, unit, base, amplitude, periodMs, digits = 1) {
  return { path, unit, base, amplitude, periodMs, digits }
}

const TAGS = [
  makeTag('/华东示范厂/灌装车间/灌装线/温度', '°C', 68, 6, 45000),
  makeTag('/华东示范厂/灌装车间/灌装线/压力', 'bar', 5.2, 0.8, 30000, 2),
  makeTag('/华东示范厂/灌装车间/灌装线/流量', 'L/min', 240, 40, 60000, 0),
  makeTag('/华东示范厂/灌装车间/包装线/主轴转速', 'rpm', 1450, 120, 50000, 0),
  makeTag('/华东示范厂/灌装车间/包装线/计数', 'pcs', 81234, 3, 1000, 0),
  makeTag('/华东示范厂/动力车间/空压机/振动', 'mm/s', 2.8, 1.2, 25000, 2),
  makeTag('/华东示范厂/动力车间/空压机/油温', '°C', 54, 9, 80000),
]

const overrides = new Map()

export function mockTree() {
  const root = { path: '', kind: 'folder', children: [] }
  for (const tag of TAGS) {
    const parts = tag.path.split('/').filter(Boolean)
    let node = root
    let acc = ''
    parts.forEach((part, index) => {
      acc += `/${part}`
      const isLeaf = index === parts.length - 1
      let child = node.children.find((candidate) => candidate.path === acc)
      if (!child) {
        child = { path: acc, kind: isLeaf ? 'file' : 'folder' }
        if (isLeaf) child.unit = tag.unit
        else child.children = []
        node.children.push(child)
      }
      node = child
    })
  }
  return [root]
}

export function mockTags() {
  return TAGS.map((tag) => tag.path)
}

export function sampleValue(tag, atMs) {
  if (overrides.has(tag.path)) {
    const anchor = overrides.get(tag.path)
    const drift = Math.sin(atMs / 90000) * tag.amplitude * 0.15
    return Number((anchor.value + drift).toFixed(tag.digits))
  }
  const phase = Math.sin((atMs / tag.periodMs) * Math.PI * 2)
  const noise = (Math.sin(atMs / 1733) + Math.cos(atMs / 917)) * 0.06
  const value = tag.base + tag.amplitude * (phase * 0.7 + noise)
  return Number(value.toFixed(tag.digits))
}

export function findTag(path) {
  return TAGS.find((tag) => tag.path === path)
}

export function mockRead(paths) {
  const at = now()
  return paths.map((path) => {
    const tag = findTag(path)
    if (!tag) return { path, value: null }
    return { path, value: sampleValue(tag, at), timestampMs: at, unit: tag.unit }
  })
}

export function mockHistory(path, startMs = Date.now() - 3600000, endMs = Date.now(), limit = 200) {
  const tag = findTag(path)
  if (!tag) return []
  const step = Math.max(1000, Math.floor((endMs - startMs) / limit))
  const points = []
  for (let t = startMs; t <= endMs && points.length < limit; t += step) {
    points.push({ path, value: sampleValue(tag, t), timestampMs: t })
  }
  return points
}

export function mockWrite(entries) {
  const at = now()
  let applied = 0
  for (const entry of entries) {
    const tag = findTag(entry.path)
    if (!tag) continue
    overrides.set(entry.path, { value: Number(Number(entry.value).toFixed(tag.digits)), at })
    applied += 1
  }
  return applied
}

export function createMockStream(topics, send, signal) {
  const timer = setInterval(() => {
    const at = now()
    for (const topic of topics) {
      const tag = findTag(topic)
      if (!tag) continue
      send({ path: topic, value: sampleValue(tag, at), timestampMs: at, unit: tag.unit })
    }
  }, 1000)
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })
}

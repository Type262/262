// Motion system: intro, reveals, split text, scroll progress, split-flap, toast.
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
export const $ = (s, r = document) => r.querySelector(s)
export const $$ = (s, r = document) => [...r.querySelectorAll(s)]

export function intro() {
  const el = $('.intro')
  const done = () => document.body.classList.add('ready')
  if (!el) { done(); return Promise.resolve() }
  let seen = false
  try { seen = !!sessionStorage.getItem('t262-intro'); sessionStorage.setItem('t262-intro', '1') } catch {}
  if (reduced || seen) { el.remove(); done(); return Promise.resolve() }
  const n = $('.n', el)
  const t0 = performance.now()
  return new Promise(res => {
    const tick = now => {
      const p = Math.min(1, (now - t0) / 1150)
      const e = 1 - Math.pow(1 - p, 3)
      n.textContent = String(Math.round(e * 262)).padStart(3, '0')
      el.style.setProperty('--p', e)
      if (p < 1) return requestAnimationFrame(tick)
      setTimeout(() => { el.classList.add('out'); done(); setTimeout(() => el.remove(), 1000); res() }, 160)
    }
    requestAnimationFrame(tick)
  })
}

// Wrap each word of .split elements so they can rise in one by one.
function splitWords(el) {
  let i = 0
  const walk = node => {
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment()
        for (const t of n.textContent.split(/(\s+)/)) {
          if (!t) continue
          if (/^\s+$/.test(t)) { frag.append(t); continue }
          const w = document.createElement('span')
          const s = document.createElement('span')
          w.className = 'w'
          s.textContent = t
          s.style.setProperty('--i', i++)
          w.append(s)
          frag.append(w)
        }
        n.replaceWith(frag)
      } else if (n.nodeType === 1) walk(n)
    }
  }
  walk(el)
}

export function reveal() {
  $$('.split').forEach(splitWords)
  const io = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' })
  $$('[data-reveal], .split').forEach(el => io.observe(el))
}

// Scroll progress 0..1. mode 'pin': through a tall sticky section. mode 'enter': as the element scrolls in.
const tracked = []
let raf = 0
function update() {
  raf = 0
  const vh = innerHeight
  for (const t of tracked) {
    const r = t.el.getBoundingClientRect()
    let p = t.mode === 'pin' ? -r.top / Math.max(1, r.height - vh) : (vh - r.top) / (vh * 0.75)
    p = Math.max(0, Math.min(1, p))
    if (p !== t.p) { t.p = p; t.fn(p) }
  }
}
const schedule = () => { if (!raf) raf = requestAnimationFrame(update) }
addEventListener('scroll', schedule, { passive: true })
addEventListener('resize', schedule)
export function onProgress(el, fn, mode = 'enter') { tracked.push({ el, fn, mode, p: -1 }); schedule() }

// Split-flap: each cell flips through random glyphs, then lands.
const GLYPHS = 'abcdefghijklmnopqrstuvwxyz0123456789.-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export function flap(el, text, speed = 32) {
  const target = [...text]
  while (el.children.length < target.length) el.append(document.createElement('b'))
  while (el.children.length > target.length) el.lastChild.remove()
  const cells = [...el.children]
  const put = (c, ch) => { c.textContent = ch === ' ' ? ' ' : ch }
  if (reduced) { cells.forEach((c, i) => put(c, target[i])); return Promise.resolve() }
  return Promise.all(cells.map((c, i) => new Promise(done => {
    if (c.textContent === target[i] || (target[i] === ' ' && c.textContent === ' ')) return done()
    let left = 3 + ((i * 5) % 6) + ((Math.random() * 4) | 0)
    const step = () => {
      const last = left-- <= 0
      put(c, last ? target[i] : GLYPHS[(Math.random() * GLYPHS.length) | 0])
      c.classList.remove('f'); void c.offsetWidth; c.classList.add('f')
      last ? done() : setTimeout(step, speed)
    }
    setTimeout(step, i * 22)
  })))
}

export function toast(msg, ms = 3200) {
  let t = $('.toast')
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.append(t) }
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._h)
  t._h = setTimeout(() => t.classList.remove('show'), ms)
}

// Ambient layer: two drifting light pools (CSS) + bioluminescent spores rising slowly (canvas).
export function ambient(count = 64) {
  const amb = document.createElement('div')
  amb.className = 'ambient'
  document.body.prepend(amb)
  if (reduced) return
  const c = document.createElement('canvas')
  c.id = 'spores'
  document.body.prepend(c)
  const ctx = c.getContext('2d')
  let w = 0, h = 0
  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    w = innerWidth; h = innerHeight
    c.width = w * dpr; c.height = h * dpr
    c.style.width = w + 'px'; c.style.height = h + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  size()
  addEventListener('resize', size)
  const ps = Array.from({ length: count }, () => ({
    x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.6, v: 0.00004 + Math.random() * 0.00012,
    a: 0.2 + Math.random() * 0.55, lime: Math.random() < 0.8, ph: Math.random() * 6.28, z: 0.3 + Math.random() * 0.7,
  }))
  let last = performance.now(), sy = scrollY
  const tick = now => {
    const dt = Math.min(50, now - last); last = now
    const dy = scrollY - sy; sy = scrollY
    ctx.clearRect(0, 0, w, h)
    for (const p of ps) {
      p.y -= p.v * dt + (dy / h) * 0.25 * p.z
      p.x += Math.sin(now * 0.0003 + p.ph) * 0.00003 * dt
      if (p.y < -0.03) { p.y = 1.03; p.x = Math.random() } else if (p.y > 1.03) p.y = -0.03
      const tw = 0.55 + 0.45 * Math.sin(now * 0.0016 + p.ph)
      const col = p.lime ? `rgba(200,255,30,${p.a * tw})` : `rgba(150,110,255,${p.a * tw})`
      ctx.fillStyle = col
      ctx.shadowColor = col
      ctx.shadowBlur = 10 * p.r
      ctx.beginPath()
      ctx.arc(p.x * w, p.y * h, p.r * p.z * 1.4, 0, 6.2832)
      ctx.fill()
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// Elements with data-par drift against the scroll (value = strength).
export function parallax() {
  const els = $$('[data-par]')
  if (reduced || !els.length) return
  const run = () => {
    const vh = innerHeight
    for (const el of els) {
      const r = el.getBoundingClientRect()
      const off = (r.top + r.height / 2 - vh / 2) * parseFloat(el.dataset.par)
      el.style.setProperty('--par', `${off.toFixed(1)}px`)
    }
  }
  addEventListener('scroll', () => requestAnimationFrame(run), { passive: true })
  run()
}

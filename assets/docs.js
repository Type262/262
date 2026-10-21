// Docs page: sidebar + search, scroll-spy, "On this page", code blocks (highlight + copy), heading links.
import { $, $$, esc, copy } from './ui.js'

const sections = $$('.dx-section')
const GROUPS = [...new Set(sections.map(s => s.dataset.group))]

// ---------- sidebar ----------
const nav = $('#dx-nav')
nav.innerHTML = GROUPS.map(g => `
  <div class="dx-group"><span class="dx-group-t">${esc(g)}</span>
    ${sections.filter(s => s.dataset.group === g).map(s => `<a href="#${s.id}" data-sec="${s.id}">${esc($('h2', s).textContent)}</a>`).join('')}
  </div>`).join('')

// ---------- headings: anchor links ----------
$$('.dx-section h2, .dx-section h3').forEach(h => {
  const id = h.id || h.closest('.dx-section').id
  if (!h.id && h.tagName === 'H3') return
  h.dataset.t = h.textContent
  const a = document.createElement('a')
  a.className = 'dx-anchor'
  a.href = `#${id}`
  a.setAttribute('aria-label', 'Link to this section')
  a.textContent = '#'
  h.append(a)
})

// ---------- code blocks ----------
const KW = {
  js: 'import from export const let var function async await return if else for of in new try catch finally throw class extends typeof instanceof true false null undefined this',
  solidity: 'pragma solidity contract interface library function external public internal private view pure payable returns return memory calldata storage address uint256 uint128 uint64 uint32 uint16 uint8 int24 bytes32 bytes4 bytes string bool mapping event emit error revert require if else for new immutable constant indexed struct modifier receive is using',
  bash: 'export cd node npm npx forge cast git curl bash sh echo sed',
  json: 'true false null',
}
const RE = {
  js: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?n?\b)|([A-Za-z_$][\w$]*)/g,
  bash: /((?:^|(?<=\s))#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w-]*)/g,
  dns: /(;[^\n]*)|("(?:[^"\\\n]|\\.)*")|(\b\d+\b)|(\b(?:IN|TXT|TYPE262|WALLET)\b)/g,
}
RE.solidity = RE.js
RE.json = RE.js
function highlight(code, lang) {
  const re = RE[lang]
  if (!re) return esc(code)
  const kw = new Set((KW[lang] || '').split(' '))
  let out = '', last = 0
  for (const m of code.matchAll(re)) {
    const [t, c, s, n, w] = m
    out += esc(code.slice(last, m.index))
    if (c) out += `<span class="tk-c">${esc(c)}</span>`
    else if (s) out += `<span class="tk-s">${esc(s)}</span>`
    else if (n) out += `<span class="tk-n">${esc(n)}</span>`
    else if (w) {
      if (lang === 'dns' || kw.has(w)) out += `<span class="tk-k">${esc(w)}</span>`
      else if (code[m.index + w.length] === '(') out += `<span class="tk-f">${esc(w)}</span>`
      else out += esc(w)
    }
    last = m.index + t.length
  }
  return out + esc(code.slice(last))
}
const LANG = { js: 'JavaScript', solidity: 'Solidity', bash: 'Terminal', json: 'JSON', dns: 'DNS', txt: 'Text', html: 'HTML' }
$$('pre.dx-code').forEach(pre => {
  const lang = pre.dataset.lang || 'txt'
  const code = pre.textContent.replace(/^\n+|\s+$/g, '')
  const block = document.createElement('div')
  block.className = 'dx-block'
  block.innerHTML = `<div class="dx-block-h"><span>${esc(LANG[lang] || lang)}</span><button type="button" class="dx-copy">Copy</button></div>`
  pre.replaceWith(block)
  pre.innerHTML = `<code>${highlight(code, lang)}</code>`
  block.append(pre)
  $('.dx-copy', block).addEventListener('click', e => copy(code, e.currentTarget))
})

// ---------- scroll-spy + "On this page" ----------
const toc = $('#dx-toc ul')
let current = null
function setCurrent(sec) {
  if (sec === current) return
  current = sec
  $$('#dx-nav a').forEach(a => a.classList.toggle('on', a.dataset.sec === sec.id))
  const subs = $$('h3[id]', sec)
  toc.innerHTML = subs.length
    ? subs.map(h => `<li><a href="#${h.id}">${esc((h.dataset.t || h.textContent))}</a></li>`).join('')
    : `<li><a href="#${sec.id}">${esc($('h2', sec).dataset.t)}</a></li>`
  $('#dx-toc').hidden = false
}
function spy() {
  const y = innerHeight * 0.28
  let best = sections[0]
  for (const s of sections) if (s.getBoundingClientRect().top <= y) best = s
  setCurrent(best)
  const subs = $$('h3[id]', best)
  let sub = null
  for (const h of subs) if (h.getBoundingClientRect().top <= y) sub = h
  $$('#dx-toc a').forEach(a => a.classList.toggle('on', !!sub && a.getAttribute('href') === `#${sub.id}`))
}
// Throttled, with a trailing run, so the last position always wins (no rAF: it stalls in background tabs).
let spyAt = 0, spyTimer = 0
function onScroll() {
  const now = Date.now()
  clearTimeout(spyTimer)
  if (now - spyAt > 80) { spyAt = now; spy() }
  spyTimer = setTimeout(spy, 120)
}
addEventListener('scroll', onScroll, { passive: true })
addEventListener('hashchange', () => setTimeout(spy, 50))
spy()

// ---------- search ----------
const q = $('#dx-q')
const results = $('#dx-results')
const index = sections.flatMap(s => {
  const title = $('h2', s).dataset.t
  const entries = [{ href: `#${s.id}`, title, where: s.dataset.group, text: s.textContent }]
  $$('h3[id]', s).forEach(h => {
    let text = ''
    for (let n = h.nextElementSibling; n && n.tagName !== 'H3'; n = n.nextElementSibling) text += ' ' + n.textContent
    entries.push({ href: `#${h.id}`, title: (h.dataset.t || h.textContent), where: title, text })
  })
  return entries
})
function search() {
  const term = q.value.trim().toLowerCase()
  nav.hidden = !!term
  results.hidden = !term
  if (!term) return
  const words = term.split(/\s+/)
  const hits = index
    .map(e => {
      const t = e.title.toLowerCase(), body = e.text.toLowerCase()
      if (!words.every(w => t.includes(w) || body.includes(w))) return null
      const score = words.reduce((n, w) => n + (t.includes(w) ? 10 : 0) + (body.split(w).length - 1), 0)
      const i = body.indexOf(words[0])
      const snip = i < 0 ? '' : e.text.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' ').trim()
      return { ...e, score, snip }
    })
    .filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 12)
  results.innerHTML = hits.length
    ? hits.map(h => `<a href="${h.href}"><b>${esc(h.title)}</b><span>${esc(h.where)}</span>${h.snip ? `<em>…${esc(h.snip)}…</em>` : ''}</a>`).join('')
    : '<p class="dx-none">No results. Try another word.</p>'
}
q.addEventListener('input', search)
q.addEventListener('keydown', e => {
  if (e.key === 'Enter') { const first = $('a', results); if (first) { location.hash = first.getAttribute('href'); q.blur() } }
  if (e.key === 'Escape') { q.value = ''; search(); q.blur() }
})
results.addEventListener('click', e => { if (e.target.closest('a')) closeDrawer() })
addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== q && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); openDrawer(); q.focus() }
})

// ---------- mobile drawer ----------
const side = $('#dx-side')
const openDrawer = () => { if (matchMedia('(max-width: 1000px)').matches) document.body.classList.add('dx-open') }
const closeDrawer = () => document.body.classList.remove('dx-open')
$('#dx-menu').addEventListener('click', () => document.body.classList.toggle('dx-open'))
nav.addEventListener('click', e => { if (e.target.closest('a')) closeDrawer() })
$('#dx-scrim').addEventListener('click', closeDrawer)
side.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer() })

// Place search: type a name, a short form (CSE, LH), an alias or a category; pick a result to fly there.
// In walk mode the picked place becomes the starting point of the walking-time rings.
import { getPlaces, openPlace, ui, CATEGORIES, getTheme } from './app.js';
import { walkFrom } from './walk.js';

const MAX_RESULTS = 8;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

// Letters of `q` appear in order in `s` (a typo-tolerant last resort: "lbrary" still finds "library").
function subsequence(q, s) {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}

function index() {
  return getPlaces().filter(p => p.lnglat).map(p => {
    const name = norm(p.name);
    const tags = [p.short, ...(p.aliases || [])].filter(Boolean).map(norm);
    const extra = norm([CATEGORIES[p.category]?.label, p.subcategory, p.residents, p.description].join(' '));
    return { p, name, words: name.split(' '), tags, extra };
  });
}

// Every query word must match somewhere; better matches (whole name, start of a word, short form) score higher.
function score(e, qWords, q) {
  if (e.name === q || e.tags.includes(q)) return 1000;
  let total = e.name.startsWith(q) ? 300 : 0;
  for (const w of qWords) {
    let best = 0;
    if (e.tags.some(t => t === w)) best = 120;
    else if (e.tags.some(t => t.startsWith(w))) best = 90;
    if (e.words.some(x => x === w)) best = Math.max(best, 100);
    else if (e.words.some(x => x.startsWith(w))) best = Math.max(best, 80);
    else if (e.name.includes(w)) best = Math.max(best, 50);
    else if (e.extra.split(' ').some(x => x.startsWith(w))) best = Math.max(best, 30);
    else if (w.length >= 4 && subsequence(w, e.name.replace(/ /g, ''))) best = Math.max(best, 15);
    if (!best) return 0;
    total += best;
  }
  return total - e.name.length * 0.1;   // prefer shorter names on ties
}

export function initSearch() {
  const box = document.createElement('div');
  box.className = 'search';
  const hint = matchMedia('(max-width: 640px)').matches ? 'Search places…' : 'Search: library, CSE, Lohit, food…';
  box.innerHTML = `<input id="q" type="search" placeholder="${hint}" autocomplete="off"
      role="combobox" aria-expanded="false" aria-controls="qres" aria-label="Search places">
    <ul id="qres" role="listbox" hidden></ul>`;
  document.querySelector('.brand').append(box);
  const input = box.querySelector('#q'), list = box.querySelector('#qres');
  let entries = index(), results = [], active = -1;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = r => {
    if (!r) return;
    input.value = r.p.name;
    close();
    input.blur();
    if (ui.mode === 'walk') walkFrom(r.p.lnglat, r.p.name);
    else openPlace(r.p.id);
  };
  const render = () => {
    const theme = getTheme();
    list.innerHTML = results.length ? results.map((r, i) => `<li role="option" id="qr${i}" aria-selected="${i === active}" data-i="${i}">
        <i style="background:${(CATEGORIES[r.p.category] || CATEGORIES.residential)[theme]}"></i>
        <span>${esc(r.p.name)}${r.p.short ? ` <em>${esc(r.p.short)}</em>` : ''}</span>
        <small>${esc(CATEGORIES[r.p.category]?.label || '')}</small></li>`).join('')
      : '<li class="none">No match. Try a short form like LH or CSE.</li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `qr${active}` : '');
    list.querySelectorAll('[data-i]').forEach(li => li.onmousedown = e => { e.preventDefault(); choose(results[+li.dataset.i]); });
  };

  input.addEventListener('focus', () => { entries = index(); if (input.value.trim()) input.dispatchEvent(new Event('input')); });
  input.addEventListener('input', () => {
    const q = norm(input.value);
    if (!q) { results = []; close(); return; }
    const qWords = q.split(' ');
    results = entries.map(e => ({ ...e, s: score(e, qWords, q) })).filter(e => e.s > 0)
      .sort((a, b) => b.s - a.s).slice(0, MAX_RESULTS);
    active = results.length ? 0 : -1;
    render();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === 'Enter') { e.preventDefault(); choose(results[Math.max(active, 0)]); }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
  // "/" focuses search from anywhere, as on many sites.
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== input && !e.target.matches?.('input, textarea, select')) { e.preventDefault(); input.focus(); }
  });
}

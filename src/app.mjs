// Heat Plan page: state, rendering and actions. Zero dependencies.
import {
  buildSlots, groupDays, shiftIndices, jobHour, bestWindow, waterTotal, statusText, waterText, fmtTemp, fmtTime, fmtDay,
  planText, encodeState, decodeState, newJob, MAX_JOBS, CLOTHING_LABEL, CLOTHING_TYPES, jobSummary,
} from './plan.mjs';
import { loadForecast, searchPlaces, safeStorage } from './forecast.mjs';
import { acclimatizationPlan } from './guidance.mjs';

const $ = (id) => document.getElementById(id);
const STATE_KEY = 'heatplan:state';
const CUP_L = 0.24;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}

const state = {
  place: null,
  jobs: [newJob(1)],
  sel: 0,
  shift: { start: 6, end: 14 },
  units: navigator.language === 'en-US' ? 'imperial' : 'metric',
  day: 0,
  shiftOnly: true,
};
let fc = null, slots = [], days = [], cur = -1;

// ---- state <-> URL hash and storage (the hash is the share link)

function restore() {
  const fromHash = decodeState(location.hash);
  const s = Object.keys(fromHash).length ? fromHash : decodeState(safeStorage.get(STATE_KEY) || '');
  if (s.place) state.place = s.place;
  if (s.jobs) state.jobs = s.jobs;
  if (s.shift) state.shift = s.shift;
  if (s.units) state.units = s.units;
  state.sel = 0;
}
function persist() {
  const h = encodeState(state);
  history.replaceState(null, '', `${location.pathname}${location.search}#${h}`);
  safeStorage.set(STATE_KEY, h);
}

// ---- forecast

const nowSec = () => Date.now() / 1000;
const currentSlot = () => slots.findIndex((s) => nowSec() >= s.start && nowSec() < s.end);

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 2) return 'just now';
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
function setStatus(msg) { $('status').textContent = msg; }

let reqId = 0;
async function refresh({ resetDay = false } = {}) {
  if (!state.place) return;
  const id = ++reqId, place = state.place;
  setStatus('');
  // never show one place's forecast under another place's name
  if (fc && (Math.abs(fc.req.lat - place.lat) > 0.05 || Math.abs(fc.req.lon - place.lon) > 0.05)) {
    fc = null; slots = []; days = []; cur = -1;
    render();
  }
  renderPlace('Loading forecast…');
  try {
    const f = await loadForecast(place.lat, place.lon);
    if (id !== reqId) return; // a newer request owns the page
    fc = f;
    slots = buildSlots(fc);
    days = groupDays(slots, fc.tz);
    cur = currentSlot();
    if (resetDay || state.day >= days.length) state.day = Math.max(0, days.findIndex((d) => d.idx.includes(cur)));
    if (fc.fromCache) setStatus(`Offline. Showing the forecast from ${ago(fc.fetchedAt)}.`);
  } catch (err) {
    if (id !== reqId) return;
    setStatus(`Could not load the forecast (${err.message || err}). Check the connection and try again.`);
  }
  render();
}

function choosePlace(place) {
  state.place = place;
  $('results').hidden = true;
  $('q').value = '';
  persist();
  refresh({ resetDay: true });
}

// ---- rendering

const units = () => state.units;
const tz = () => fc.tz;
const job = () => state.jobs[state.sel];
const lv = (p) => `lv${p.level < 0 ? 'u' : p.level}`;
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
const litres = (quarts) => String(Math.round(quarts * 4 * CUP_L * 10) / 10).replace(/\.0$/, '');
const fmtMinutes = (m) => (m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

function chipText(p) {
  if (p.status === 'normal') return 'Work';
  if (p.status === 'cycle') return `${p.workMin} / ${p.restMin}`;
  if (p.status === 'stop') return 'No work';
  if (p.status === 'danger') return 'Danger';
  return '–';
}
const waterShort = (q) => (q == null ? 'Drink regularly' : `1 cup / ${Math.round(60 / (q * 4))} min`);

function renderPlace(note) {
  const pl = $('place-line');
  pl.replaceChildren();
  if (!state.place) { pl.append(el('span', {}, 'Search for a town or use your location.')); return; }
  pl.append(el('strong', {}, state.place.name));
  if (note) pl.append(el('span', {}, note));
  else if (fc) {
    pl.append(el('span', {}, `${fmtTime(nowSec(), tz())} local`), el('span', {}, `forecast ${ago(fc.fetchedAt)}`),
      el('button', { class: 'link', type: 'button', onclick: () => refresh() }, 'Refresh'));
  }
}

function renderTabs() {
  const tabs = $('job-tabs');
  tabs.replaceChildren(...state.jobs.map((j, k) => el('button', {
    type: 'button', role: 'tab', 'aria-selected': String(k === state.sel),
    onclick: () => { state.sel = k; renderEditor(); render(); },
  }, j.name)));
  const sum = jobSummary(job());
  $('job-summary').textContent = sum.charAt(0).toUpperCase() + sum.slice(1) + '.';
  if (state.jobs.length < MAX_JOBS) {
    tabs.append(el('button', {
      type: 'button', class: 'add', onclick: () => {
        state.jobs.push(newJob(state.jobs.length + 1));
        state.sel = state.jobs.length - 1;
        $('job-details').open = true;
        persist(); renderEditor(); render();
      },
    }, '+ Add job'));
  }
}

function renderEditor() {
  const j = job();
  $('j-name').value = j.name;
  for (const name of ['work', 'where', 'breaks', 'crew']) {
    for (const input of document.querySelectorAll(`input[name=${name}]`)) input.checked = input.value === j[name];
  }
  $('j-cloth').value = j.clothing;
  $('j-remove').hidden = state.jobs.length < 2;
}

function renderNow() {
  const sec = $('now-sec');
  sec.hidden = !fc;
  if (!fc) return;
  if (cur < 0) {
    sec.className = 'card now lvu';
    sec.replaceChildren(el('p', { class: 'big' }, 'Forecast out of date'), el('p', {}, 'Refresh when you have a connection.'));
    return;
  }
  const j = job(), s = slots[cur], p = jobHour(s, j);
  let next = null, limited = p.status !== 'normal';
  for (let i = cur + 1; i < Math.min(slots.length, cur + 24); i++) {
    const q = jobHour(slots[i], j);
    if (q.status !== 'normal') limited = true;
    if (!next && (q.status !== p.status || q.workMin !== p.workMin)) next = { i, q };
  }
  // the best window only matters when some hour ahead is limited
  const bw = limited ? bestWindow(slots, j, cur, 24, 4) : null;
  sec.className = `card now ${lv(p)}`;
  sec.replaceChildren(
    el('p', { class: 'eyebrow' }, `Now · ${j.name} · ${fmtTime(s.start, tz())}–${fmtTime(s.end, tz())}`),
    el('p', { class: 'big' }, statusText(p)),
    el('p', { class: 'water' }, waterText(p.water.quarts, units())),
    el('p', { class: 'detail' }, `Heat stress (WBGT) ${fmtTemp(s.sun, units())} in sun, ${fmtTemp(s.shade, units())} in shade · air ${fmtTemp(s.tair, units())}, ${Math.round(s.rh)}% humidity`),
    el('div', { class: 'more' },
      el('p', {}, next ? `From ${fmtTime(slots[next.i].start, tz())}: ${statusText(next.q)}` : 'No change in the next 24 hours'),
      bw && el('p', {}, `Coolest 4 hours ahead: ${fmtTime(slots[bw.from].start, tz())}–${fmtTime(slots[bw.to - 1].end, tz())} · ${bw.workMin === 240 ? 'work normally' : `${fmtMinutes(bw.workMin)} of work`}`)),
    el('p', { class: 'est' }, 'Forecast estimate, not a measurement.'),
  );
}

function renderGrid() {
  const sec = $('week-sec');
  sec.hidden = !fc || !days.length;
  if (sec.hidden) return;
  const j = job();
  $('week-title').textContent = `7 days · ${j.name}`;
  const g = $('grid');
  const head = el('div', { class: 'hours', 'aria-hidden': 'true' }, el('span'), ...Array.from({ length: 24 }, (_, h) => el('span', {}, h % 6 === 0 ? String(h) : '')));
  const dayFmt = new Intl.DateTimeFormat(undefined, { timeZone: tz(), weekday: 'short', day: 'numeric' });
  const rows = days.map((d, k) => el('button', {
    type: 'button', class: `row${k === state.day ? ' sel' : ''}`, 'aria-label': `${fmtDay(slots[d.idx[0]].start, tz())}: show plan`,
    onclick: () => { state.day = k; render(); $('day-sec').scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  },
  el('span', { class: 'day' }, dayFmt.format(new Date(slots[d.idx[0]].start * 1000))),
  ...Array.from({ length: 24 }, (_, h) => {
    const i = d.byHour[h];
    if (i == null) return el('i', { class: 'lvu' });
    const p = jobHour(slots[i], j);
    return el('i', { class: `${lv(p)}${i < cur ? ' past' : ''}${i === cur ? ' cur' : ''}`, title: `${fmtTime(slots[i].start, tz())} ${statusText(p)}` });
  })));
  g.replaceChildren(head, ...rows);
}

function dayIndices(d) {
  return state.shiftOnly ? shiftIndices(slots, tz(), d.dateKey, state.shift) : d.idx;
}

function renderDay() {
  const sec = $('day-sec');
  sec.hidden = !fc || !days.length;
  if (sec.hidden) return;
  const d = days[state.day];
  const today = days.findIndex((x) => x.idx.includes(cur));
  $('day-title').textContent = `${state.day === today ? 'Today · ' : ''}${fmtDay(slots[d.idx[0]].start, tz())}`;
  $('day-prev').disabled = state.day === 0;
  $('day-next').disabled = state.day === days.length - 1;
  $('shift-only').checked = state.shiftOnly;

  const indices = dayIndices(d);
  const inShift = new Set(shiftIndices(slots, tz(), d.dateKey, state.shift));
  const table = $('day-table');
  const short = (c) => (!Number.isFinite(c) ? '–' : units() === 'imperial' ? `${Math.round(c * 1.8 + 32)}°` : `${c.toFixed(1)}°`);
  const head = el('thead', {}, el('tr', {}, el('th', {}, 'Time', el('small', {}, 'WBGT sun / shade')), ...state.jobs.map((j) => el('th', {}, j.name))));
  const body = el('tbody', {}, indices.map((i) => {
    const s = slots[i];
    return el('tr', { class: [i < cur && 'past', i === cur && 'cur', !inShift.has(i) && 'off'].filter(Boolean).join(' ') },
      el('td', { class: 't' }, fmtTime(s.start, tz()), el('small', {}, `${short(s.sun)} / ${short(s.shade)}`)),
      ...state.jobs.map((j) => {
        const p = jobHour(s, j);
        return el('td', {}, el('span', { class: `chip ${lv(p)}` }, el('b', {}, chipText(p)), el('small', {}, waterShort(p.water.quarts))));
      }));
  }));
  table.replaceChildren(head, body);
  if (!indices.length) table.replaceChildren(el('caption', {}, 'The shift is outside the forecast for this day.'));

  const wt = $('water-total');
  wt.replaceChildren(...(indices.length ? state.jobs.map((j) => {
    const w = waterTotal(indices, slots, j);
    const amount = units() === 'imperial' ? `${w.quarts} qt` : `${litres(w.quarts)} L`;
    return el('p', { class: w.overCap ? 'over' : '' },
      `${j.name}: about ${amount} of water over ${indices.length} h${w.regular ? ` plus regular drinks for ${w.regular} h` : ''}.${w.overCap ? ' Over the 12 qt (11 L) daily limit: shorten the shift.' : ''}`);
  }) : []));

  // print header (hidden on screen)
  let ph = sec.querySelector('.print-head');
  if (!ph) { ph = el('div', { class: 'print-head' }); sec.prepend(ph); }
  ph.replaceChildren(
    el('h2', {}, `Heat plan · ${state.place.name} · ${fmtDay(slots[d.idx[0]].start, tz())}`),
    el('p', {}, state.shiftOnly ? `Shift ${hourLabel(state.shift.start)}–${hourLabel(state.shift.end)}` : 'Whole day'),
    ...state.jobs.map((j) => el('p', {}, `${j.name}: ${jobSummary(j)}`)),
    el('p', {}, 'Forecast estimate, not a measurement. Sources: NIOSH 2016, TB MED 507 (2022), Liljegren WBGT (Argonne), Open-Meteo.com.'),
  );
}

function renderAcclim() {
  const len = ((state.shift.end - state.shift.start + 24) % 24) || 24;
  const fmt = (f) => { const q = Math.floor(len * f * 4) / 4; const h = Math.floor(q), m = Math.round((q - h) * 60); return m ? `${h} h ${m}` : `${h} h`; };
  const fresh = acclimatizationPlan(false), back = acclimatizationPlan(true);
  $('acclim-table').replaceChildren(
    el('tr', {}, el('th', {}, `Day (${len} h shift)`), ...fresh.map((_, k) => el('th', {}, String(k + 1)))),
    el('tr', {}, el('th', {}, 'New'), ...fresh.map((f) => el('td', {}, fmt(f)))),
    el('tr', {}, el('th', {}, 'Returning'), ...fresh.map((_, k) => el('td', {}, fmt(back[Math.min(k, back.length - 1)])))),
  );
}

function render() {
  cur = currentSlot();
  $('units').textContent = state.units === 'imperial' ? '°F · qt' : '°C · L';
  $('shift-start').value = String(state.shift.start);
  $('shift-end').value = String(state.shift.end);
  renderPlace();
  renderTabs();
  renderNow();
  renderGrid();
  renderDay();
  renderAcclim();
}

// ---- actions

async function copy(text, button) {
  let done = false;
  try { await navigator.clipboard.writeText(text); done = true; } catch {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
    try { done = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  const label = button.textContent;
  button.textContent = done ? 'Copied' : 'Copy failed';
  setTimeout(() => { button.textContent = label; }, 1800);
}

function currentText() {
  if (!fc || !days.length) return '';
  return planText({ placeName: state.place.name, tz: tz(), slots, indices: dayIndices(days[state.day]), jobs: state.jobs, units: state.units, url: location.href });
}

function updateJob(field, value) {
  job()[field] = value;
  persist();
  render();
}

function wire() {
  $('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('q').value.trim();
    if (!q) return;
    const list = $('results');
    list.hidden = false;
    list.replaceChildren(el('li', {}, el('button', { type: 'button', disabled: true }, 'Searching…')));
    try {
      const found = await searchPlaces(q, { lang: (navigator.language || 'en').slice(0, 2) });
      list.replaceChildren(...(found.length ? found.map((r) => el('li', {}, el('button', {
        type: 'button', onclick: () => choosePlace({ name: `${r.name}, ${r.country || r.cc}`, lat: r.lat, lon: r.lon }),
      }, r.name, ' ', el('small', {}, [r.admin1, r.country].filter(Boolean).join(', '))))) : [el('li', {}, el('button', { type: 'button', disabled: true }, 'No places found'))]));
    } catch (err) {
      list.replaceChildren(el('li', {}, el('button', { type: 'button', disabled: true }, `Search failed: ${err.message || err}`)));
    }
  });

  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) { setStatus('Location is not available in this browser.'); return; }
    setStatus('');
    navigator.geolocation.getCurrentPosition(
      (pos) => choosePlace({ name: `My location (${pos.coords.latitude.toFixed(2)}, ${pos.coords.longitude.toFixed(2)})`, lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => setStatus(`Could not get your location (${err.message}). Search for a town instead.`),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  });

  $('j-name').addEventListener('input', (e) => {
    job().name = e.target.value.slice(0, 30) || `Crew ${state.sel + 1}`;
    persist();
    renderTabs(); renderNow(); renderGrid(); renderDay();
  });
  for (const name of ['work', 'where', 'breaks', 'crew']) {
    for (const input of document.querySelectorAll(`input[name=${name}]`)) input.addEventListener('change', () => updateJob(name, input.value));
  }
  const cloth = $('j-cloth');
  cloth.replaceChildren(...CLOTHING_TYPES.map((c) => el('option', { value: c }, CLOTHING_LABEL[c])));
  cloth.addEventListener('change', () => updateJob('clothing', cloth.value));
  $('j-remove').addEventListener('click', () => {
    if (state.jobs.length < 2) return;
    state.jobs.splice(state.sel, 1);
    state.sel = Math.max(0, state.sel - 1);
    persist(); renderEditor(); render();
  });

  for (const id of ['shift-start', 'shift-end']) {
    const sel = $(id);
    sel.replaceChildren(...Array.from({ length: 24 }, (_, h) => el('option', { value: String(h) }, hourLabel(h))));
    sel.addEventListener('change', () => {
      state.shift = { start: +$('shift-start').value, end: +$('shift-end').value };
      persist(); render();
    });
  }

  $('units').addEventListener('click', () => { state.units = state.units === 'imperial' ? 'metric' : 'imperial'; persist(); render(); });
  $('day-prev').addEventListener('click', () => { state.day = Math.max(0, state.day - 1); render(); });
  $('day-next').addEventListener('click', () => { state.day = Math.min(days.length - 1, state.day + 1); render(); });
  $('shift-only').addEventListener('change', (e) => { state.shiftOnly = e.target.checked; render(); });
  $('copy-text').addEventListener('click', (e) => copy(currentText(), e.currentTarget));
  $('copy-link').addEventListener('click', (e) => copy(location.href, e.currentTarget));
  $('print').addEventListener('click', () => window.print());
  if (navigator.share) {
    $('share').hidden = false;
    $('share').addEventListener('click', () => navigator.share({ title: 'Heat plan', text: currentText() }).catch(() => {}));
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && fc && Date.now() - fc.fetchedAt > 3600e3) refresh();
  });
  setInterval(() => { if (fc && currentSlot() !== cur) render(); }, 60e3);
  window.addEventListener('hashchange', () => { restore(); renderEditor(); refresh({ resetDay: true }); });
}

restore();
wire();
renderEditor();
render();
persist();
refresh({ resetDay: true });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

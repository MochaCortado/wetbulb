/*
 * plan.mjs — forecast hours → WBGT → per-job work/rest and water, plus the
 * grouping, best-window, share-text and share-link helpers the page uses.
 * Pure functions (no DOM). Zero dependencies.
 */
import { calcWbgt } from './wbgt.mjs';
import { workRest, waterPerHour, CLOTHING_ADJ, WATER_CAP_QT_DAY } from './guidance.mjs';

// Forecast 10 m wind below this is raised to it before the model reduces it to 2 m,
// as in KNMI's operational Liljegren WBGT (documented in ECMWF thermofeel, Heat Force).
// Hourly-mean forecast winds near calm are unreliable, and the model is very sensitive there.
export const WIND_FLOOR_10M = 0.62;

export const WORK_TYPES = ['light', 'moderate', 'heavy', 'veryHeavy'];
export const CLOTHING_TYPES = Object.keys(CLOTHING_ADJ);
export const MAX_JOBS = 6;
export const newJob = (n = 1) => ({ name: `Crew ${n}`, work: 'moderate', where: 'sun', breaks: 'shade', crew: 'acclimatized', clothing: 'work' });

/**
 * Hourly slots [time[i], time[i+1]). Instantaneous fields are averaged to the
 * slot midpoint; Open-Meteo's shortwave_radiation at time[i+1] is the mean over
 * the slot, so the model runs at time[i+1] with avg = 60 (centred on the midpoint).
 * Wind below WIND_FLOOR_10M is raised to it.
 */
export function buildSlots(fc) {
  const slots = [];
  for (let i = 0; i + 1 < fc.time.length; i++) {
    const mid = (a) => (a[i] == null || a[i + 1] == null ? null : 0.5 * (a[i] + a[i + 1]));
    const tair = mid(fc.tair), rh = mid(fc.rh), wind = mid(fc.wind), pres = mid(fc.pres), solar = fc.solar[i + 1];
    let sun = NaN, shade = NaN;
    if ([tair, rh, wind, pres, solar].every(Number.isFinite)) {
      const d = new Date(fc.time[i + 1] * 1000);
      const p = {
        year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(),
        gmt: 0, avg: 60, lat: fc.lat, lon: fc.lon, solar: Math.max(0, solar), pres, tair,
        rh: Math.min(100, Math.max(0, rh)), speed: Math.max(WIND_FLOOR_10M, wind), zspeed: 10, dT: 0, urban: false,
      };
      sun = calcWbgt(p).wbgt;
      shade = calcWbgt({ ...p, shade: true }).wbgt;
    }
    slots.push({ start: fc.time[i], end: fc.time[i + 1], tair, rh, wind, solar, sun, shade });
  }
  return slots;
}

const partsFmt = new Map();
/** Local date key (YYYY-MM-DD), hour and minute of a unix time in an IANA zone. */
export function localParts(t, tz) {
  if (!partsFmt.has(tz)) {
    partsFmt.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  const p = Object.fromEntries(partsFmt.get(tz).formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

/** First n local days: [{dateKey, idx: slot indices in order, byHour: {hour: first index}}]. */
export function groupDays(slots, tz, n = 7) {
  const out = [];
  slots.forEach((s, i) => {
    const { dateKey, hour } = localParts(s.start, tz);
    let d = out[out.length - 1];
    if (!d || d.dateKey !== dateKey) {
      if (out.length === n) return;
      d = { dateKey, idx: [], byHour: {} };
      out.push(d);
    }
    d.idx.push(i);
    if (!(hour in d.byHour)) d.byHour[hour] = i;
  });
  return out;
}

/** Slot indices of a shift starting on dateKey at local hour start (end may wrap past midnight; start = end is 24 h). */
export function shiftIndices(slots, tz, dateKey, shift) {
  const len = ((shift.end - shift.start + 24) % 24) || 24;
  const first = slots.findIndex((s) => { const p = localParts(s.start, tz); return p.dateKey === dateKey && p.hour === shift.start; });
  if (first < 0) return [];
  return Array.from({ length: Math.min(len, slots.length - first) }, (_, k) => first + k);
}

/** 0 work normally, 1 ≥45 min, 2 ≥30 min, 3 ≥15 min, 4 stop, 5 danger, -1 unknown. */
export function level(p) {
  if (p.status === 'normal') return 0;
  if (p.status === 'cycle') return p.workMin >= 45 ? 1 : p.workMin >= 30 ? 2 : 3;
  if (p.status === 'stop') return 4;
  if (p.status === 'danger') return 5;
  return -1;
}

/** Plan for one job in one slot: workRest result + WBGTs, water and level. */
export function jobHour(slot, job) {
  const wbgtWork = job.where === 'shade' ? slot.shade : slot.sun;
  const wbgtRest = job.breaks === 'shade' ? slot.shade : wbgtWork;
  const wr = workRest({ wbgtWork, wbgtRest, work: job.work, acclimatized: job.crew !== 'new', clothing: job.clothing });
  const water = waterPerHour({ wbgt: wbgtWork + (CLOTHING_ADJ[job.clothing] ?? 0), twaM: wr.twaM });
  return { ...wr, wbgtWork, wbgtRest, water, level: level(wr) };
}

const runKey = (p) => `${p.status}|${p.workMin}|${p.water.quarts}`;

/** Consecutive slots with the same instruction merged: [{from, to (exclusive), plan}] in slot indices. */
export function groupRuns(indices, slots, job) {
  const runs = [];
  for (const i of indices) {
    const p = jobHour(slots[i], job);
    const last = runs[runs.length - 1];
    if (last && last.to === i && runKey(last.plan) === runKey(p)) last.to = i + 1;
    else runs.push({ from: i, to: i + 1, plan: p });
  }
  return runs;
}

/** The len-hour window in [from, from + span) with the most work minutes (ties: lower mean WBGT). */
export function bestWindow(slots, job, from, span = 24, len = 4) {
  let best = null;
  const end = Math.min(slots.length, from + span);
  for (let a = Math.max(0, from); a + len <= end; a++) {
    const plans = [];
    for (let i = a; i < a + len; i++) plans.push(jobHour(slots[i], job));
    if (plans.some((p) => p.status === 'unknown')) continue;
    const work = plans.reduce((s, p) => s + p.workMin, 0);
    const wbgt = plans.reduce((s, p) => s + p.wbgtWork, 0) / len;
    if (!best || work > best.workMin || (work === best.workMin && wbgt < best.meanWbgt - 1e-9)) best = { from: a, to: a + len, workMin: work, meanWbgt: wbgt, plans };
  }
  return best;
}

/** Water over a list of slot indices: total quarts, hours without a table value, and whether 12 qt is exceeded. */
export function waterTotal(indices, slots, job) {
  let quarts = 0, regular = 0;
  for (const i of indices) {
    const q = jobHour(slots[i], job).water.quarts;
    if (q == null) regular++;
    else quarts += q;
  }
  return { quarts, regular, overCap: quarts > WATER_CAP_QT_DAY };
}

// ---- wording (English; kept here so the share text and the page say the same thing)

export const WORK_LABEL = { light: 'Light', moderate: 'Moderate', heavy: 'Heavy', veryHeavy: 'Very heavy' };
export const CLOTHING_LABEL = {
  work: 'Normal work clothes', coveralls: 'Cloth coveralls', doubleLayer: 'Double-layer clothing',
  sms: 'SMS coveralls', polyolefin: 'Polyolefin coveralls', vaporBarrier: 'Vapour-barrier suit',
};

export function statusText(p) {
  switch (p.status) {
    case 'normal': return 'Work normally';
    case 'cycle': return `Work ${p.workMin} min, rest ${p.restMin} min`;
    case 'stop': return 'No work: rest';
    case 'danger': return 'Danger: get to a cool place';
    default: return 'No data';
  }
}

const QT_FRAC = { 0.5: '½', 0.75: '¾', 1: '1', 1.25: '1¼', 1.5: '1½' };
/** Water per hour as cups (240 mL = 8 oz = ¼ qt) and litres or quarts. */
export function waterText(quarts, units = 'metric') {
  if (quarts == null) return 'Drink regularly';
  const cups = Math.round(quarts * 4);
  const amount = units === 'imperial' ? `${QT_FRAC[quarts] ?? quarts} qt` : `${String(Math.round(cups * 2.4) / 10).replace(/\.0$/, '')} L`;
  return `1 cup every ${Math.round(60 / cups)} min (${amount}/h)`;
}

export const fmtTemp = (c, units = 'metric') =>
  !Number.isFinite(c) ? '–' : units === 'imperial' ? `${Math.round(c * 1.8 + 32)}°F` : `${c.toFixed(1)}°C`;

export function fmtTime(t, tz, locale) {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(t * 1000));
}
export function fmtDay(t, tz, locale) {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(t * 1000));
}

export function jobSummary(job) {
  return `${WORK_LABEL[job.work]} work, ${job.where === 'shade' ? 'in shade' : 'in sun'}, breaks ${job.breaks === 'shade' ? 'in shade' : 'in the same place'}, ${job.crew === 'new' ? 'new or higher-risk workers' : 'used to the heat'}${job.clothing !== 'work' ? `, ${CLOTHING_LABEL[job.clothing].toLowerCase()}` : ''}`;
}

/** Plain-text plan for messaging apps: one block per job, hours merged. */
export function planText({ placeName, tz, slots, indices, jobs, units = 'metric', locale, url }) {
  if (!indices.length) return '';
  const first = slots[indices[0]], last = slots[indices[indices.length - 1]];
  const lines = [`HEAT PLAN · ${placeName} · ${fmtDay(first.start, tz, locale)} · ${fmtTime(first.start, tz, locale)}–${fmtTime(last.end, tz, locale)}`];
  for (const job of jobs) {
    lines.push('', `${job.name}: ${jobSummary(job)}`);
    for (const r of groupRuns(indices, slots, job)) {
      lines.push(`${fmtTime(slots[r.from].start, tz, locale)}–${fmtTime(slots[r.to - 1].end, tz, locale)}  ${statusText(r.plan)} · ${waterText(r.plan.water.quarts, units)}`);
    }
    const w = waterTotal(indices, slots, job);
    if (w.overCap) lines.push('Over 12 qt (11 L) of water for this shift: shorten it.');
  }
  lines.push('', 'Heat stroke (confusion, collapse, hot skin): call emergency services and cool the person with water now.');
  lines.push('Forecast estimate, not a measurement.' + (url ? ` ${url}` : ''));
  return lines.join('\n');
}

// ---- share link: everything needed to rebuild the page, in the URL hash

const CODES = {
  work: { l: 'light', m: 'moderate', h: 'heavy', v: 'veryHeavy' },
  where: { s: 'sun', h: 'shade' },
  breaks: { h: 'shade', s: 'same' },
  crew: { a: 'acclimatized', n: 'new' },
  clothing: { w: 'work', c: 'coveralls', d: 'doubleLayer', p: 'sms', o: 'polyolefin', v: 'vaporBarrier' },
};
const FIELDS = ['work', 'where', 'breaks', 'crew', 'clothing'];
const codeOf = (field, value) => Object.keys(CODES[field]).find((k) => CODES[field][k] === value);

export function encodeState({ place, jobs, shift, units }) {
  const q = new URLSearchParams();
  if (place) { q.set('p', `${place.lat.toFixed(4)},${place.lon.toFixed(4)}`); q.set('n', place.name); }
  for (const j of jobs) q.append('j', `${FIELDS.map((f) => codeOf(f, j[f])).join('')}:${j.name}`);
  q.set('s', `${shift.start}-${shift.end}`);
  q.set('u', units === 'imperial' ? 'i' : 'm');
  return q.toString();
}

/** Parses a share hash; invalid parts are dropped. Returns {place?, jobs?, shift?, units?}. */
export function decodeState(hash) {
  const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const out = {};
  const p = (q.get('p') || '').split(',').map(Number);
  if (p.length === 2 && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180 && p.every(Number.isFinite)) {
    out.place = { lat: p[0], lon: p[1], name: (q.get('n') || 'Shared place').slice(0, 80) };
  }
  const jobs = [];
  for (const raw of q.getAll('j').slice(0, MAX_JOBS)) {
    const [code, ...rest] = raw.split(':');
    if (code.length !== FIELDS.length) continue;
    const job = { name: rest.join(':').trim().slice(0, 30) || `Crew ${jobs.length + 1}` };
    if (FIELDS.every((f, k) => (job[f] = CODES[f][code[k]]))) jobs.push(job);
  }
  if (jobs.length) out.jobs = jobs;
  const s = (q.get('s') || '').match(/^(\d{1,2})-(\d{1,2})$/);
  if (s && +s[1] < 24 && +s[2] < 24) out.shift = { start: +s[1], end: +s[2] };
  if (q.get('u') === 'i' || q.get('u') === 'm') out.units = q.get('u') === 'i' ? 'imperial' : 'metric';
  return out;
}

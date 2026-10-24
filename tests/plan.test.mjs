// Plan and forecast checks with synthetic data and a stub fetch (no network).
import { buildSlots, localParts, groupDays, shiftIndices, groupRuns, bestWindow, waterTotal, waterText, statusText, fmtTemp,
  jobHour, planText, encodeState, decodeState, newJob, WIND_FLOOR_10M } from '../src/plan.mjs';
import { calcWbgt } from '../src/wbgt.mjs';
import { parseForecast, loadForecast, cachedForecast, forecastUrl } from '../src/forecast.mjs';

const ok = (name, pass, detail = '') => ({ name, pass: !!pass, detail });

// A synthetic hot-humid day cycle (Dhaka-like), hourly from a local midnight.
function synthetic({ t0, hours = 192, lat = 23.81, lon = 90.41, tz = 'Asia/Dhaka', offsetH = 6 }) {
  const time = [], tair = [], rh = [], wind = [], pres = [], solar = [];
  for (let k = 0; k < hours; k++) {
    const t = t0 + k * 3600, lh = (((k % 24) + 24) % 24);
    const day = Math.max(0, Math.sin(((lh - 6) / 12) * Math.PI));
    time.push(t); tair.push(28 + 6 * day); rh.push(85 - 30 * day); wind.push(2); pres.push(1008);
    const prevDay = Math.max(0, Math.sin(((lh - 6.5) / 12) * Math.PI)); // preceding-hour mean, roughly
    solar.push(Math.round(850 * prevDay));
  }
  return { lat, lon, tz, time, tair, rh, wind, pres, solar, offsetH };
}
// 2026-07-15 00:00 in Dhaka (UTC+6) = 2026-07-14 18:00 UTC
const T0 = Date.UTC(2026, 6, 14, 18) / 1000;

function stubFetch(map) {
  return async (url) => {
    for (const [k, v] of Object.entries(map)) if (url.includes(k)) {
      if (v instanceof Error) throw v;
      return { ok: true, status: 200, json: async () => v };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
function memStorage() { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); return true; } }; }

export const planSuite = {
  name: 'Plan and forecast (src/plan.mjs, src/forecast.mjs)',
  async run() {
    const res = [];
    const fc = synthetic({ t0: T0 });
    const slots = buildSlots(fc);

    // 1. Slots
    const s9 = slots[9]; // local 09:00-10:00
    const d = new Date(fc.time[10] * 1000);
    const direct = calcWbgt({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: 0, gmt: 0, avg: 60,
      lat: fc.lat, lon: fc.lon, solar: fc.solar[10], pres: 1008, tair: (fc.tair[9] + fc.tair[10]) / 2, rh: (fc.rh[9] + fc.rh[10]) / 2, speed: 2, zspeed: 10, dT: 0 });
    res.push(ok('Slot = midpoint weather + next-hour mean radiation, avg 60', slots.length === 191 && Math.abs(s9.sun - direct.wbgt) < 1e-12,
      `${slots.length} slots; 09–10 sun ${s9.sun.toFixed(2)} vs direct ${direct.wbgt.toFixed(2)}`));
    res.push(ok('Every slot: shade ≤ sun, both finite', slots.every((s) => Number.isFinite(s.sun) && s.shade <= s.sun + 1e-9)));
    const calm = buildSlots({ ...fc, wind: fc.wind.map(() => 0.05) }), floor = buildSlots({ ...fc, wind: fc.wind.map(() => WIND_FLOOR_10M) });
    const breezy = buildSlots({ ...fc, wind: fc.wind.map(() => 1.5) });
    res.push(ok('Near-calm wind is raised to the 0.62 m/s floor (KNMI); stronger wind untouched', calm.every((s, k) => s.sun === floor[k].sun) && breezy[12].sun < floor[12].sun,
      `noon: calm ${calm[12].sun.toFixed(2)} = floor ${floor[12].sun.toFixed(2)}, 1.5 m/s ${breezy[12].sun.toFixed(2)}`));
    const gap = buildSlots({ ...fc, tair: fc.tair.map((v, i) => (i === 5 ? null : v)) });
    res.push(ok('Missing forecast value → that hour unknown, neighbours fine', Number.isNaN(gap[4].sun) && Number.isNaN(gap[5].sun) && Number.isFinite(gap[6].sun)
      && jobHour(gap[5], newJob()).status === 'unknown'));

    // 2. Local time handling
    const kol = localParts(Date.UTC(2026, 9, 24, 18, 30) / 1000, 'Asia/Kolkata');
    const ny = localParts(Date.UTC(2026, 6, 15, 3) / 1000, 'America/New_York');
    res.push(ok('Local date/hour in half-hour and DST zones', kol.dateKey === '2026-10-25' && kol.hour === 0 && ny.dateKey === '2026-07-14' && ny.hour === 23,
      `Kolkata ${kol.dateKey} ${kol.hour}:${kol.minute}, New York ${ny.dateKey} ${ny.hour}`));
    const days = groupDays(slots, fc.tz);
    res.push(ok('7 local days of 24 hours each (no DST)', days.length === 7 && days.every((x) => x.idx.length === 24 && Object.keys(x.byHour).length === 24),
      days.map((x) => `${x.dateKey}:${x.idx.length}`).join(' ')));
    // Madrid leaves summer time on 2026-10-25: that local day has 25 hours
    const mad = buildSlots({ ...synthetic({ t0: Date.UTC(2026, 9, 22, 22) / 1000, lat: 40.42, lon: -3.7 }), tz: 'Europe/Madrid' });
    const madDays = groupDays(mad, 'Europe/Madrid');
    const oct25 = madDays.find((x) => x.dateKey === '2026-10-25');
    res.push(ok('DST change day has 25 slots, grid still 24 columns', oct25 && oct25.idx.length === 25 && Object.keys(oct25.byHour).length === 24,
      oct25 ? `${oct25.idx.length} slots, ${Object.keys(oct25.byHour).length} hours` : 'missing'));

    // 3. Shifts
    const dayShift = shiftIndices(slots, fc.tz, days[1].dateKey, { start: 6, end: 14 });
    const night = shiftIndices(slots, fc.tz, days[1].dateKey, { start: 20, end: 4 });
    const all = shiftIndices(slots, fc.tz, days[1].dateKey, { start: 0, end: 0 });
    const lp = (i) => localParts(slots[i].start, fc.tz);
    res.push(ok('Shifts: 06–14 = 8 h, 20–04 crosses midnight, 0–0 = 24 h',
      dayShift.length === 8 && lp(dayShift[0]).hour === 6 && night.length === 8 && lp(night[7]).hour === 3 && lp(night[7]).dateKey === days[2].dateKey && all.length === 24));

    // 4. Runs, best window, water totals
    const job = newJob();
    const runs = groupRuns(days[1].idx, slots, job);
    const covered = runs.reduce((n, r) => n + (r.to - r.from), 0);
    const merged = runs.every((r, k) => k === 0 || statusText(r.plan) + r.plan.water.quarts !== statusText(runs[k - 1].plan) + runs[k - 1].plan.water.quarts);
    res.push(ok('Runs cover the day and merge identical neighbours', covered === 24 && merged && runs.length < 24, `${runs.length} runs`));
    const bw = bestWindow(slots, job, days[1].idx[0], 24, 4);
    const lh = lp(bw.from).hour;
    res.push(ok('Best 4-hour window falls at night/early morning', bw && (lh >= 20 || lh <= 4), `starts ${lh}:00, ${bw.workMin} work min, mean ${bw.meanWbgt.toFixed(1)}`));
    const heavyCoverall = { ...job, work: 'veryHeavy', clothing: 'doubleLayer' };
    const wt = waterTotal(all, slots, heavyCoverall), wl = waterTotal(dayShift, slots, { ...job, work: 'light', where: 'shade' });
    res.push(ok('24 h very heavy work in double layers flags the 12 qt limit; an 8 h light shade shift does not', wt.overCap && !wl.overCap,
      `${wt.quarts} qt vs ${wl.quarts} qt (+${wl.regular} h "drink regularly")`));

    // 5. Wording
    const wtx = [[0.5, 'metric', '1 cup every 30 min (0.5 L/h)'], [0.75, 'metric', '1 cup every 20 min (0.7 L/h)'], [1, 'metric', '1 cup every 15 min (1 L/h)'],
      [1.25, 'metric', '1 cup every 12 min (1.2 L/h)'], [1.5, 'metric', '1 cup every 10 min (1.4 L/h)'], [0.75, 'imperial', '1 cup every 20 min (¾ qt/h)'], [null, 'metric', 'Drink regularly']];
    const wbad = wtx.filter(([q, u, s]) => waterText(q, u) !== s);
    res.push(ok('Water wording (cup = 240 mL = ¼ qt)', !wbad.length, wbad.map(([q, u]) => `${q} ${u}: ${waterText(q, u)}`).join('; ') || waterText(1)));
    res.push(ok('Temperature wording', fmtTemp(30.04) === '30.0°C' && fmtTemp(30, 'imperial') === '86°F' && fmtTemp(NaN) === '–'));
    const text = planText({ placeName: 'Dhaka, Bangladesh', tz: fc.tz, slots, indices: dayShift, jobs: [job, { ...job, name: 'Diggers', work: 'heavy' }], locale: 'en-GB', url: 'https://example.org/#x' });
    res.push(ok('Share text: header, both jobs, merged hours, first aid, under 1,200 chars',
      text.startsWith('HEAT PLAN · Dhaka') && text.includes('Crew 1:') && text.includes('Diggers:') && text.includes('Heat stroke') && text.length < 1200,
      `${text.length} chars, ${text.split('\n').length} lines`));

    // 6. Share link
    const state = { place: { name: 'Doha, Qatar', lat: 25.28545, lon: 51.53096 }, jobs: [job, { name: 'Roof: east <b>', work: 'veryHeavy', where: 'shade', breaks: 'same', crew: 'new', clothing: 'vaporBarrier' }], shift: { start: 20, end: 4 }, units: 'imperial' };
    const back = decodeState('#' + encodeState(state));
    res.push(ok('Share link round-trips place, jobs, shift and units', back.place.name === 'Doha, Qatar' && Math.abs(back.place.lat - 25.2855) < 1e-4 && back.jobs.length === 2
      && JSON.stringify(back.jobs[1]) === JSON.stringify(state.jobs[1]) && back.shift.start === 20 && back.units === 'imperial', encodeState(state).length + ' chars'));
    const junk = decodeState('#p=999,5&j=zzzzz:x&j=mshaw&s=30-2&u=q');
    res.push(ok('Bad link parts are dropped', !junk.place && junk.jobs.length === 1 && junk.jobs[0].name === 'Crew 1' && !junk.shift && !junk.units, JSON.stringify(junk)));

    // 7. Forecast loading with cache fallback (stub fetch, in-memory storage)
    const api = { latitude: 25.3, longitude: 51.5, timezone: 'Asia/Qatar', elevation: 2, hourly: { time: fc.time.slice(0, 4), temperature_2m: [30, 31, 32, 33], relative_humidity_2m: [50, 50, 50, 50], wind_speed_10m: [2, 2, 2, 2], surface_pressure: [1010, 1010, 1010, 1010], shortwave_radiation: [0, 100, 200, 300] } };
    const store = memStorage();
    const live = await loadForecast(25.3, 51.5, { fetchFn: stubFetch({ 'api.open-meteo.com': api }), storage: store, now: 1000 });
    const offline = await loadForecast(25.31, 51.49, { fetchFn: stubFetch({ 'api.open-meteo.com': new TypeError('Failed to fetch') }), storage: store });
    let threw = false;
    try { await loadForecast(-6.2, 106.8, { fetchFn: stubFetch({ 'api.open-meteo.com': new TypeError('Failed to fetch') }), storage: store }); } catch { threw = true; }
    res.push(ok('Offline: same place falls back to the cached forecast; another place errors', !live.fromCache && offline.fromCache && offline.fetchedAt === 1000 && threw && cachedForecast(25.3, 51.5, store)));
    let badParse = false;
    try { parseForecast({ hourly: { time: [1] } }); } catch { badParse = true; }
    res.push(ok('Empty forecast is rejected; URL asks for unixtime, local timezone, m/s, 8 days', badParse && /timeformat=unixtime/.test(forecastUrl(1, 2)) && /timezone=auto/.test(forecastUrl(1, 2)) && /wind_speed_unit=ms/.test(forecastUrl(1, 2)) && /forecast_days=8/.test(forecastUrl(1, 2))));

    return res;
  },
};

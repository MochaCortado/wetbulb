// WBGT port checks: the C oracle (local, test-only) plus physical properties.
import { calcWbgt, solarPosition } from '../src/wbgt.mjs';

const TOL_ORACLE = 0.05; // degC, max |delta| against the C build
const TOL_MONO = 0.05; // degC, slack for the 0.02 convergence threshold

function fromOracle(i) {
  return {
    year: i.year, month: i.month, day: i.day, hour: i.hour, minute: i.minute, gmt: i.gmt, avg: i.avg,
    lat: i.lat, lon: i.lon, solar: i.solar, pres: i.pressure, tair: i.tempC, rh: i.rh,
    speed: i.windSpeed, zspeed: i.windHeight, dT: i.dT, urban: !!i.urban,
  };
}

// A hot, sunny midday in Doha (UTC 09:00 = 12:00 local) used as the base for property sweeps.
const BASE = { year: 2026, month: 7, day: 15, hour: 9, minute: 0, gmt: 0, avg: 0, lat: 25.29, lon: 51.53,
  solar: 850, pres: 1000, tair: 40, rh: 30, speed: 3, zspeed: 10, dT: 0, urban: false };
const NIGHT = { ...BASE, hour: 21, solar: 0, tair: 33, rh: 60 }; // 00:00 local

const f2 = (x) => (Number.isFinite(x) ? x.toFixed(3) : String(x));

// NOAA Solar Calculator equations (after Meeus), written independently of Larson's routine.
// Returns apparent altitude (NOAA refraction model) and declination, degrees.
function noaaSun(year, month, day, utHours, lat, lon) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const jd = 367 * year - Math.floor((7 * (year + Math.floor((month + 9) / 12))) / 4) + Math.floor((275 * month) / 9) + day + 1721013.5 + utHours / 24;
  const jc = (jd - 2451545) / 36525;
  const l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const c = Math.sin(m * rad) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(2 * m * rad) * (0.019993 - 0.000101 * jc) + Math.sin(3 * m * rad) * 0.000289;
  const appLong = l0 + c - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * jc) * rad);
  const obl0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obl = obl0 + 0.00256 * Math.cos((125.04 - 1934.136 * jc) * rad);
  const decl = Math.asin(Math.sin(obl * rad) * Math.sin(appLong * rad));
  const y = Math.tan((obl / 2) * rad) ** 2;
  const eqTime = 4 * deg * (y * Math.sin(2 * l0 * rad) - 2 * e * Math.sin(m * rad) + 4 * e * y * Math.sin(m * rad) * Math.cos(2 * l0 * rad)
    - 0.5 * y * y * Math.sin(4 * l0 * rad) - 1.25 * e * e * Math.sin(2 * m * rad));
  const tst = (((utHours * 60 + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const cosZ = Math.sin(lat * rad) * Math.sin(decl) + Math.cos(lat * rad) * Math.cos(decl) * Math.cos(ha * rad);
  const alt = 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) * deg;
  let refr = 0;
  const t = Math.tan(alt * rad);
  if (alt > 85) refr = 0;
  else if (alt > 5) refr = 58.1 / t - 0.07 / t ** 3 + 0.000086 / t ** 5;
  else if (alt > -0.575) refr = 1735 + alt * (-518.2 + alt * (103.4 + alt * (-12.79 + alt * 0.711)));
  else refr = -20.772 / t;
  return { altitude: alt + refr / 3600, declination: decl * deg };
}

function monotone(name, key, values, fieldOut = 'wbgt', base = BASE) {
  let worst = Infinity, at = null;
  let prev = calcWbgt({ ...base, [key]: values[0] })[fieldOut];
  for (let k = 1; k < values.length; k++) {
    const cur = calcWbgt({ ...base, [key]: values[k] })[fieldOut];
    const step = cur - prev;
    if (!(step >= worst) || Number.isNaN(step)) { worst = Number.isNaN(step) ? NaN : Math.min(worst, step); at = values[k]; }
    prev = cur;
  }
  return { name, pass: worst >= -TOL_MONO, detail: `smallest step ${f2(worst)} at ${key}=${at}` };
}

export const wbgtSuite = {
  name: 'WBGT model (src/wbgt.mjs)',
  async run() {
    const res = [];
    // The oracle has no licence, so it is never published; without it these checks are skipped.
    const got = await fetch('../ref/liljegren-oracle.json', { cache: 'no-store' }).catch(() => null);
    const oracle = got && got.ok ? await got.json() : [];
    if (!oracle.length) res.push({ name: 'Oracle comparison skipped (oracle file not present)', pass: true, detail: 'local test-only file, see ref/README.md' });

    // 1. Oracle comparison. The C counts the leap day twice in leap years after 2000
    //    (fixed in the port, modification 6), so those cases are replayed one day later,
    //    which reproduces the C's sun exactly and still checks every other line.
    const fields = [['wbgt', 'wbgt'], ['tg', 'globe'], ['tnwb', 'naturalWetBulb']];
    const stats = Object.fromEntries(fields.map(([k]) => [k, { max: 0, sum: 0, worst: null }]));
    const cBugYear = (y) => y > 2000 && y % 4 === 0;
    const CZA_MIN = 0.00873;
    const replayOf = (p) => (cBugYear(p.year) ? { ...p, day: p.day + 1 } : p);
    let nan = 0, nLeap = 0, leapShift = 0, nCliff = 0;
    for (const c of oracle) {
      const p = fromOracle(c.input);
      const got = calcWbgt(replayOf(p));
      if (cBugYear(p.year)) {
        nLeap++;
        const fixed = calcWbgt(p);
        // crossing the C's horizon cutoff switches solar handling, so a tiny sun shift can jump
        if ((fixed.cza < CZA_MIN) !== (got.cza < CZA_MIN)) nCliff++;
        else leapShift = Math.max(leapShift, Math.abs(fixed.wbgt - got.wbgt));
      }
      for (const [k, ek] of fields) {
        const d = Math.abs(got[k] - c.expected[ek]);
        if (Number.isNaN(d)) { nan++; continue; }
        const s = stats[k];
        s.sum += d;
        if (d > s.max) { s.max = d; s.worst = { input: c.input, expected: c.expected[ek], got: got[k] }; }
      }
    }
    if (oracle.length) {
    res.push({ name: `Oracle: ${oracle.length} cases, no NaN`, pass: nan === 0 && oracle.length === 418, detail: `${nan} NaN` });
    for (const [k, ek] of fields) {
      const s = stats[k];
      const w = s.worst ? ` worst ${f2(s.worst.got)} vs ${f2(s.worst.expected)} at ${s.worst.input.month}/${s.worst.input.day} ${s.worst.input.hour}h T=${s.worst.input.tempC} RH=${s.worst.input.rh} S=${s.worst.input.solar} lat=${s.worst.input.lat}` : '';
      res.push({ name: `Oracle ${ek}: max |Δ| ≤ ${TOL_ORACLE} °C`, pass: s.max <= TOL_ORACLE,
        detail: `max ${f2(s.max)}, mean ${(s.sum / oracle.length).toFixed(4)}.${w}` });
    }
    res.push({ name: 'Leap-year date fix moves WBGT ≤ 0.05 °C (except across the horizon cutoff)', pass: nLeap > 0 && leapShift <= 0.05,
      detail: `${nLeap} oracle cases in 2028; largest change ${f2(leapShift)} °C; ${nCliff} case(s) cross CZA_MIN and are excluded` });
    }

    // 2. Shade never hotter than sun (oracle inputs plus the base sweep)
    let shadeBad = 0, shadeWorst = 0;
    for (const c of oracle) {
      const p = fromOracle(c.input);
      const sun = calcWbgt(p), sh = calcWbgt({ ...p, shade: true });
      const d = sh.wbgt - sun.wbgt;
      if (d > TOL_MONO) shadeBad++;
      shadeWorst = Math.max(shadeWorst, d);
      const dg = sh.tg - sun.tg;
      if (dg > TOL_MONO) shadeBad++;
    }
    if (oracle.length) res.push({ name: 'Shade WBGT and globe ≤ sun (oracle inputs)', pass: shadeBad === 0, detail: `${shadeBad} violations, largest shade−sun ${f2(shadeWorst)}` });
    const bs = calcWbgt(BASE), bsh = calcWbgt({ ...BASE, shade: true });
    res.push({ name: 'Shade lowers midday Doha WBGT noticeably', pass: bs.wbgt - bsh.wbgt > 1,
      detail: `sun ${f2(bs.wbgt)} (globe ${f2(bs.tg)}), shade ${f2(bsh.wbgt)} (globe ${f2(bsh.tg)}), fdir ${f2(bs.fdir)}` });

    // 3. Monotonic in temperature, humidity, sunlight
    const range = (a, b, s) => Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s);
    res.push(monotone('Rises with air temperature (RH fixed)', 'tair', range(10, 50, 1)));
    res.push(monotone('Rises with humidity', 'rh', range(5, 100, 5)));
    res.push(monotone('Rises with sunlight', 'solar', range(0, 1100, 50)));
    res.push(monotone('Globe rises with sunlight', 'solar', range(0, 1100, 50), 'tg'));
    res.push(monotone('Rises with temperature at night', 'tair', range(15, 40, 1), 'wbgt', NIGHT));

    // 4. Night behaviour
    const n = calcWbgt(NIGHT), nsh = calcWbgt({ ...NIGHT, shade: true });
    res.push({ name: 'Night: sun below horizon, no direct beam', pass: n.cza < 0 && n.fdir === 0, detail: `cza ${f2(n.cza)}, fdir ${n.fdir}` });
    res.push({ name: 'Night: shade = sun', pass: n.wbgt === nsh.wbgt, detail: `${f2(n.wbgt)} vs ${f2(nsh.wbgt)}` });
    res.push({ name: 'Night: globe ≤ air, WBGT < air', pass: n.tg <= NIGHT.tair + 0.05 && n.wbgt < NIGHT.tair,
      detail: `air ${NIGHT.tair}, globe ${f2(n.tg)}, nwb ${f2(n.tnwb)}, wbgt ${f2(n.wbgt)}` });
    res.push({ name: 'Night: solar reported at night is ignored for direct beam', pass: calcWbgt({ ...NIGHT, solar: 50 }).fdir === 0, detail: '' });

    // 5. Wet bulb relations
    let wbBad = 0, wbDetail = '';
    for (const tair of [10, 25, 35, 45]) for (const rh of [10, 40, 70, 100]) {
      const r = calcWbgt({ ...BASE, tair, rh });
      if (!(r.tpsy <= tair + 0.05)) { wbBad++; wbDetail = `tpsy ${f2(r.tpsy)} > tair ${tair} at rh ${rh}`; }
      if (!(r.tnwb >= r.tpsy - 0.05)) { wbBad++; wbDetail = `sunny nwb ${f2(r.tnwb)} < psy ${f2(r.tpsy)} at T ${tair} rh ${rh}`; }
    }
    res.push({ name: 'Psychrometric wet bulb ≤ air; sunny natural wet bulb ≥ psychrometric', pass: wbBad === 0, detail: wbBad ? wbDetail : '16 combos' });
    const sat = calcWbgt({ ...NIGHT, rh: 100 });
    res.push({ name: 'Saturated air: psychrometric wet bulb ≈ air', pass: Math.abs(sat.tpsy - NIGHT.tair) < 0.3, detail: `tpsy ${f2(sat.tpsy)} at tair ${NIGHT.tair}` });

    // 6. Solar position sanity
    const jun = solarPosition(2026, 6, 21.5, 23.44, 0);
    const dec = solarPosition(2026, 12, 21.5, -23.44, 0);
    res.push({ name: 'Solstice declinations ≈ ±23.44°', pass: Math.abs(jun.declination - 23.44) < 0.1 && Math.abs(dec.declination + 23.44) < 0.1,
      detail: `June ${f2(jun.declination)}, Dec ${f2(dec.declination)}` });
    // Solar noon at Greenwich moves with the equation of time: about 12:14 UT on Feb 11, 11:44 UT on Nov 3.
    const noon = (month, day, lat) => {
      let best = -99, at = 0;
      for (let m = 600; m <= 840; m += 0.25) { const a = solarPosition(2026, month, day + m / 1440, lat, 0).altitude; if (a > best) { best = a; at = m; } }
      return { alt: best, at, dec: solarPosition(2026, month, day + at / 1440, lat, 0).declination };
    };
    const feb = noon(2, 11, -13.9), nov = noon(11, 3, -15.1);
    const hm = (m) => `${Math.floor(m / 60)}:${String((m % 60).toFixed(1)).padStart(4, '0')}`;
    res.push({ name: 'Solar noon follows the equation of time (±1 min)', pass: Math.abs(feb.at - 734.2) < 1 && Math.abs(nov.at - 703.6) < 1,
      detail: `Feb 11 ${hm(feb.at)} UT (expect ≈12:14.2), Nov 3 ${hm(nov.at)} UT (expect ≈11:43.6)` });
    res.push({ name: 'Noon altitude = 90° − |lat − declination|', pass: Math.abs(feb.alt - (90 - Math.abs(-13.9 - feb.dec))) < 0.05 && Math.abs(nov.alt - (90 - Math.abs(-15.1 - nov.dec))) < 0.05,
      detail: `Feb ${f2(feb.alt)} vs ${f2(90 - Math.abs(-13.9 - feb.dec))}, Nov ${f2(nov.alt)} vs ${f2(90 - Math.abs(-15.1 - nov.dec))}` });

    // Independent check: NOAA solar calculator (Meeus) at random places and times worldwide.
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    let maxAlt = 0, maxDec = 0, worstAlt = '', nCmp = 0;
    for (let k = 0; k < 3000; k++) {
      const year = 2026 + Math.floor(rnd() * 5), month = 1 + Math.floor(rnd() * 12), dom = 1 + Math.floor(rnd() * 28), ut = rnd() * 24;
      const lat = -60 + rnd() * 130, lon = -180 + rnd() * 360;
      const ours = solarPosition(year, month, dom + ut / 24, lat, lon);
      const ref = noaaSun(year, month, dom, ut, lat, lon);
      maxDec = Math.max(maxDec, Math.abs(ours.declination - ref.declination));
      if (ref.altitude > 5) {
        nCmp++;
        const d = Math.abs(ours.altitude - ref.altitude);
        if (d > maxAlt) { maxAlt = d; worstAlt = `${year}-${month}-${dom} ${ut.toFixed(2)}h ${lat.toFixed(1)},${lon.toFixed(1)}: ${f2(ours.altitude)} vs ${f2(ref.altitude)}`; }
      }
    }
    res.push({ name: 'Sun altitude matches NOAA within 0.05° worldwide (alt > 5°)', pass: maxAlt < 0.05 && maxDec < 0.02,
      detail: `${nCmp} daytime points; max |Δalt| ${maxAlt.toFixed(4)}° (${worstAlt}); max |Δdec| ${maxDec.toFixed(4)}°` });
    res.push({ name: 'Earth–Sun distance: perihelion < aphelion', pass: solarPosition(2026, 1, 3.5, 0, 0).distance < 0.984 && solarPosition(2026, 7, 4.5, 0, 0).distance > 1.016,
      detail: `${f2(solarPosition(2026, 1, 3.5, 0, 0).distance)} / ${f2(solarPosition(2026, 7, 4.5, 0, 0).distance)}` });

    // 7. Date edges: hour 0 with a 60-min average reaches back into the previous day/month/year
    const edgeA = calcWbgt({ ...BASE, month: 3, day: 1, hour: 0, avg: 60 });
    const edgeB = calcWbgt({ ...BASE, month: 2, day: 28, hour: 23, minute: 30, avg: 0 });
    const edgeC = calcWbgt({ ...BASE, year: 2026, month: 1, day: 1, hour: 0, avg: 60 });
    const edgeD = calcWbgt({ ...BASE, year: 2025, month: 12, day: 31, hour: 23, minute: 30, avg: 0 });
    res.push({ name: 'Month and year roll-back with avg=60 at hour 0', pass: Math.abs(edgeA.cza - edgeB.cza) < 1e-9 && Math.abs(edgeC.cza - edgeD.cza) < 1e-9,
      detail: `Mar 1 00h avg60 cza ${edgeA.cza.toFixed(6)} vs Feb 28 23:30 ${edgeB.cza.toFixed(6)}; Jan 1 ${edgeC.cza.toFixed(6)} vs Dec 31 ${edgeD.cza.toFixed(6)}` });
    const leap = calcWbgt({ ...BASE, year: 2028, month: 3, day: 1, hour: 0, avg: 60 });
    const leapB = calcWbgt({ ...BASE, year: 2028, month: 2, day: 29, hour: 23, minute: 30, avg: 0 });
    res.push({ name: 'Leap year roll-back (2028-03-01 → 02-29)', pass: Math.abs(leap.cza - leapB.cza) < 1e-9, detail: `${leap.cza.toFixed(6)} vs ${leapB.cza.toFixed(6)}` });

    // 8. Fallback solver (modification 5) agrees with the C iteration and the oracle
    const bstats = { wbgt: 0, tg: 0, tnwb: 0 };
    let bOracle = 0;
    for (const c of oracle) {
      const p = replayOf(fromOracle(c.input));
      const fp = calcWbgt(p), bi = calcWbgt({ ...p, _solver: 'bisect' });
      for (const k of Object.keys(bstats)) bstats[k] = Math.max(bstats[k], Math.abs(fp[k] - bi[k]) || Infinity);
      bOracle = Math.max(bOracle, Math.abs(bi.wbgt - c.expected.wbgt) || Infinity);
    }
    if (oracle.length) res.push({ name: 'Bisection fallback matches the C iteration (≤ 0.05 °C, oracle inputs)', pass: Math.max(...Object.values(bstats)) <= 0.05 && bOracle <= 0.05,
      detail: `max |Δ| wbgt ${f2(bstats.wbgt)}, globe ${f2(bstats.tg)}, nwb ${f2(bstats.tnwb)}; vs oracle wbgt ${f2(bOracle)}` });
    const gale = range(10, 30, 1).map((speed) => calcWbgt({ ...BASE, tair: -10, rh: 60, speed, hour: 21, solar: 0 }).wbgt);
    const galeJump = Math.max(...gale.slice(1).map((v, k) => Math.abs(v - gale[k])));
    res.push({ name: 'Smooth across the C iteration\'s divergence (−10 °C, 10→30 m/s)', pass: gale.every(Number.isFinite) && galeJump < 0.3,
      detail: `largest 1 m/s step ${f2(galeJump)}; wbgt ${f2(gale[0])} → ${f2(gale.at(-1))}` });

    // 9. Convergence sweep over the range a global forecast can produce
    let total = 0, fails = [];
    for (const tair of range(-10, 52, 4)) for (const rh of [0, 2, 10, 30, 60, 90, 100]) for (const speed of [0, 0.5, 2, 6, 15, 30])
      for (const [hour, solar] of [[9, 0], [9, 400], [9, 1100], [21, 0]]) for (const shade of [false, true]) for (const pres of [600, 800, 1013]) {
        total++;
        const r = calcWbgt({ ...BASE, tair, rh, speed, hour, solar, shade, pres });
        if (!Number.isFinite(r.wbgt) || !(r.tpsy <= tair + 0.05)) fails.push(`T${tair} RH${rh} v${speed} h${hour} S${solar} P${pres}${shade ? ' shade' : ''}`);
      }
    res.push({ name: 'Finite and sane across a global input sweep (incl. 0% RH, 600 hPa)', pass: fails.length === 0,
      detail: `${total - fails.length}/${total} ok${fails.length ? '; e.g. ' + fails.slice(0, 6).join(', ') : ''}` });

    // 10. Speed: a 7-day hourly forecast in sun and shade
    const t0 = performance.now();
    for (let h = 0; h < 168; h++) { calcWbgt({ ...BASE, hour: h % 24, day: 15 + Math.floor(h / 24) }); calcWbgt({ ...BASE, hour: h % 24, day: 15 + Math.floor(h / 24), shade: true }); }
    const ms = performance.now() - t0;
    res.push({ name: '336 calls (7 days × 24 h × sun/shade) under 100 ms', pass: ms < 100, detail: `${ms.toFixed(1)} ms` });

    return res;
  },
};

// Guidance checks: NIOSH 2016 limits, work/rest splits, TB MED 507 (2022) water, acclimatization.
import { rel, ral, workRest, heatCategory, waterPerHour, acclimatizationPlan, METABOLIC_W, CLOTHING_ADJ } from '../src/guidance.mjs';
import { calcWbgt } from '../src/wbgt.mjs';

const r1 = (x) => Math.round(x * 10) / 10;
const ok = (name, pass, detail = '') => ({ name, pass: !!pass, detail });

export const guidanceSuite = {
  name: 'Guidance (src/guidance.mjs)',
  async run() {
    const res = [];

    // 1. NIOSH equations (handoff section 6 values, 0.1 degC)
    const expect = [[rel, 300, 28.2], [ral, 300, 25.0], [rel, 180, 30.8], [ral, 180, 28.1], [rel, 115, 33.0], [ral, 115, 30.8]];
    const bad = expect.filter(([fn, M, v]) => r1(fn(M)) !== v);
    res.push(ok('REL/RAL match NIOSH 2016 at 115, 180, 300 W', bad.length === 0,
      expect.map(([fn, M]) => `${fn === rel ? 'REL' : 'RAL'}(${M})=${fn(M).toFixed(2)}`).join(' ')));

    // 2. Work/rest splits, moderate work, acclimatized, rest in the same heat.
    //    Reproduces the ACGIH table: 75% work up to 29.0, 50% up to 30.0.
    const mod = (wbgt, extra = {}) => workRest({ wbgtWork: wbgt, work: 'moderate', ...extra });
    const cases = [[28.0, 'normal', 60], [28.5, 'cycle', 45], [29.0, 'cycle', 45], [29.5, 'cycle', 30], [30.0, 'cycle', 30],
      [30.5, 'cycle', 15], [31.5, 'stop', 0], [33.5, 'danger', 0]];
    const wrong = cases.map(([w, s, m]) => [w, s, m, mod(w)]).filter(([, s, m, r]) => r.status !== s || r.workMin !== m);
    res.push(ok('Moderate work in 15-min steps (28→60, 28.5→45, 29→45, 29.5→30, 30→30, 30.5→15, 31.5 stop, 33.5 danger)', wrong.length === 0,
      wrong.length ? wrong.map(([w, s, m, r]) => `${w}: got ${r.status} ${r.workMin}, want ${s} ${m}`).join('; ')
        : cases.map(([w]) => `${w}:${mod(w).workMin}`).join(' ')));
    const at45 = mod(29.0), at30 = mod(30.0);
    res.push(ok('TWA limits at 45/15 and 30/30 ≈ ACGIH 29.0 and 30.0 (±0.1)', Math.abs(at45.limit - 29.0) <= 0.1 && Math.abs(at30.limit - 30.0) <= 0.1,
      `45/15 limit ${at45.limit.toFixed(2)}, 30/30 limit ${at30.limit.toFixed(2)}`));

    // 3. Modifiers
    const shaded = workRest({ wbgtWork: 30.5, wbgtRest: 28.0, work: 'moderate' });
    res.push(ok('Shaded rest area allows more work (30.5 sun, 28 shade → 30 min vs 15)', shaded.workMin === 30 && mod(30.5).workMin === 15, `${shaded.status} ${shaded.workMin}/${shaded.restMin}`));
    const unacc = mod(26, { acclimatized: false }), acc26 = mod(26);
    res.push(ok('Unacclimatized (RAL) at 26: 30/30 vs normal when acclimatized', unacc.workMin === 30 && acc26.status === 'normal', `RAL ${unacc.status} ${unacc.workMin}, REL ${acc26.status}`));
    const dbl = mod(26, { clothing: 'doubleLayer' });
    res.push(ok('Double-layer clothing (+3) at 26 acts like 29 → 45/15', dbl.workMin === 45, `${dbl.status} ${dbl.workMin}, twa ${dbl.twaWbgt.toFixed(2)}`));
    const vb = mod(25, { clothing: 'vaporBarrier' });
    res.push(ok('Vapour-barrier coveralls (+11) at 25 → danger', vb.status === 'danger', `${vb.status}, twa ${vb.twaWbgt.toFixed(1)}`));
    res.push(ok('Unknown input → status unknown', workRest({ wbgtWork: NaN, work: 'light' }).status === 'unknown' && workRest({ wbgtWork: 30, work: 'flying' }).status === 'unknown'));

    // 4. Monotone: more heat never allows more work, for every work type, both limits, both clothing extremes
    const order = { normal: 0, cycle: 1, stop: 2, danger: 3 };
    let monoBad = '';
    for (const work of Object.keys(METABOLIC_W)) for (const acclimatized of [true, false]) for (const clothing of ['work', 'polyolefin']) {
      let prev = null;
      for (let w = 18; w <= 38; w += 0.1) {
        const r = workRest({ wbgtWork: w, wbgtRest: w - 1.5, work, acclimatized, clothing });
        if (prev && (r.workMin > prev.workMin || order[r.status] < order[prev.status])) monoBad = `${work} acc=${acclimatized} ${clothing} at ${w.toFixed(1)}`;
        prev = r;
      }
    }
    res.push(ok('Work minutes never rise as WBGT rises (all work types)', !monoBad, monoBad || '5 work types × 2 limits × 2 clothing × 201 steps'));
    const heavier = Object.keys(METABOLIC_W).map((k) => mod(29.5, { work: k }).workMin);
    res.push(ok('Heavier work never allows more minutes at the same WBGT', heavier.every((m, i) => i === 0 || m <= heavier[i - 1]), heavier.join(' ≥ ')));
    let stepBad = '';
    for (let w = 20; w <= 36; w += 0.05) for (const work of Object.keys(METABOLIC_W)) { const m = mod(w, { work }).workMin; if (m % 15) stepBad = `${work} ${w.toFixed(2)} → ${m}`; }
    res.push(ok('Work minutes are always 60, 45, 30, 15 or 0', !stepBad, stepBad || '321 × 5 checks'));

    // 5. Heat categories (TB MED 507: 78, 82, 85, 88, 90 degF)
    const cats = [[25.5, 0], [25.6, 1], [27.7, 1], [27.8, 2], [29.4, 2], [29.5, 3], [31.1, 3], [31.2, 4], [32.2, 4], [32.3, 5], [40, 5]];
    const catBad = cats.filter(([c, k]) => heatCategory(c) !== k);
    res.push(ok('Heat category boundaries (78/82/85/88/90 °F)', catBad.length === 0 && heatCategory(NaN) === null,
      catBad.map(([c, k]) => `${c}°C → ${heatCategory(c)} want ${k}`).join('; ') || cats.map(([c]) => `${c}:${heatCategory(c)}`).join(' ')));

    // 6. Water: table corners reproduced exactly, interpolation rounds up, caps hold
    const table = [[0.5, 0.75, 0.75, 0.75], [0.5, 1, 1, 1], [0.75, 1, 1, 1], [0.75, 1.25, 1.25, 1.25], [1, 1.5, 1.5, 1.5]];
    const mid = [26.5, 28.5, 30.3, 31.6, 33];
    let corner = '';
    table.forEach((row, c) => [250, 425, 600, 800].forEach((M, j) => { const q = waterPerHour({ wbgt: mid[c], twaM: M }).quarts; if (q !== row[j]) corner += `cat${c + 1}@${M}W=${q} want ${row[j]}; `; }));
    res.push(ok('Water reproduces TB MED 507 (2022) Table 3-3 at all 20 cells', !corner, corner || 'all 20 cells'));
    const w300 = waterPerHour({ wbgt: 28.5, twaM: 300 });
    res.push(ok('Between columns: rounds up to ¼ qt (cat 2, 300 W → 0.75 qt)', w300.quarts === 0.75 && Math.abs(w300.liters - 0.7098) < 0.001, `${w300.quarts} qt = ${w300.liters.toFixed(3)} L`));
    let capBad = '';
    for (let w = 25; w <= 40; w += 0.25) for (let M = 100; M <= 900; M += 25) { const q = waterPerHour({ wbgt: w, twaM: M }).quarts; if (q !== null && (q > 1.5 || q < 0.5)) capBad = `${w} ${M} → ${q}`; }
    res.push(ok('Water stays within ½–1½ qt/hr everywhere', !capBad, capBad || '61 × 33 grid'));
    res.push(ok('Below category 1: no table value', waterPerHour({ wbgt: 24, twaM: 300 }).quarts === null && waterPerHour({ wbgt: 24, twaM: 300 }).category === 0));

    // 7. Acclimatization (NIOSH 2016 Table 4-1)
    res.push(ok('Acclimatization: new 20→100% in 5 days, experienced 50/60/80/100%',
      acclimatizationPlan(false).join() === '0.2,0.4,0.6,0.8,1' && acclimatizationPlan(true).join() === '0.5,0.6,0.8,1'));
    res.push(ok('Clothing table matches NIOSH 2016 Table 3-2 (2006 column)',
      JSON.stringify(CLOTHING_ADJ) === JSON.stringify({ work: 0, coveralls: 0, doubleLayer: 3, sms: 0.5, polyolefin: 1, vaporBarrier: 11 })));

    // 8. End to end: midday Doha in July, moderate work
    const P = { year: 2026, month: 7, day: 15, hour: 9, lat: 25.29, lon: 51.53, solar: 850, pres: 1000, tair: 40, rh: 30, speed: 3 };
    const sun = calcWbgt(P).wbgt, shade = calcWbgt({ ...P, shade: true }).wbgt;
    const plan = workRest({ wbgtWork: sun, wbgtRest: shade, work: 'moderate' });
    const night = calcWbgt({ ...P, hour: 23, solar: 0, tair: 32, rh: 55 }).wbgt;
    const planN = workRest({ wbgtWork: night, work: 'moderate' });
    res.push(ok('Doha July: midday moderate work stops; 2 a.m. allows more', plan.status === 'stop' && planN.workMin > 0,
      `noon sun ${sun.toFixed(1)}/shade ${shade.toFixed(1)} → ${plan.status}; 2 a.m. ${night.toFixed(1)} → ${planN.status} ${planN.workMin}/${planN.restMin}, water ${waterPerHour({ wbgt: night, twaM: planN.twaM }).quarts} qt`));

    return res;
  },
};

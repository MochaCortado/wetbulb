/*
 * guidance.mjs — turns WBGT into a work/rest plan, water per hour and an
 * acclimatization schedule. Zero dependencies. All sources are US government
 * works (public domain); facts checked against the PDFs on 2026-10-23.
 *
 * Exposure limits: NIOSH [2016] Criteria for a Recommended Standard:
 *   Occupational Exposure to Heat and Hot Environments, DHHS (NIOSH) Pub.
 *   2016-106. Ch. 8: RAL = 59.9 - 14.1 log10 M, REL = 56.7 - 11.5 log10 M
 *   (degC-WBGT, M in W). Ch. 1: "both environmental and metabolic heat are
 *   expressed as 1-hour time-weighted averages", "including all scheduled
 *   and unscheduled rest periods". Table 3-2 (2006 column): clothing
 *   adjustment factors. Table 4-1: acclimatization schedules.
 * Metabolic classes: ISO 8996 class means (65/100/165/230/290 W/m2) for a
 *   1.8 m2 worker, the values ACGIH uses: 115/180/300/415/520 W.
 * Water: TB MED 507 (12 April 2022) Heat Stress Control and Heat Casualty
 *   Management, Table 3-3 (continuous work): quarts per hour by heat
 *   category and work intensity (250/425/600/800 W); caps of 1.5 qt per hour
 *   and 12 qt per day (Tables 3-2 and 3-3, notes).
 */

export const METABOLIC_W = { rest: 115, light: 180, moderate: 300, heavy: 415, veryHeavy: 520 };

// degC-WBGT added to the measured WBGT (NIOSH 2016 Table 3-2, 2006 values)
export const CLOTHING_ADJ = { work: 0, coveralls: 0, doubleLayer: 3, sms: 0.5, polyolefin: 1, vaporBarrier: 11 };

// Work per hour in 15-minute steps (60/45/30/15), as in NIOSH's limit curves and the
// ACGIH work/rest table; finer steps would claim more precision than the model has.
const MIN_WORK_MIN = 15;
const STEP_MIN = 15;
const QT_L = 0.946352946;
export const WATER_CAP_QT_HR = 1.5;
export const WATER_CAP_QT_DAY = 12;

/** NIOSH Recommended Exposure Limit (acclimatized), degC-WBGT. */
export const rel = (M) => 56.7 - 11.5 * Math.log10(M);
/** NIOSH Recommended Alert Limit (unacclimatized), degC-WBGT. */
export const ral = (M) => 59.9 - 14.1 * Math.log10(M);

const metabolic = (work) => (typeof work === 'number' ? work : METABOLIC_W[work]);

/**
 * Most work minutes per hour that keep the hourly TWA within the limit.
 * @param {object} p
 *   wbgtWork  WBGT where the work is done, degC
 *   wbgtRest  WBGT where breaks are taken (defaults to wbgtWork)
 *   work      METABOLIC_W key or watts
 *   acclimatized  true: REL, false: RAL
 *   clothing  CLOTHING_ADJ key (default 'work')
 * @returns {{status:'normal'|'cycle'|'stop'|'danger'|'unknown', workMin:number, restMin:number,
 *   limit:number, twaWbgt:number, twaM:number, margin:number}}
 *   normal: work all hour. cycle: work workMin, rest restMin. stop: no work
 *   (resting is within the limit). danger: even resting in the rest area exceeds it.
 *   limit/twaWbgt/twaM/margin describe the chosen split (or full rest for stop/danger).
 */
export function workRest({ wbgtWork, wbgtRest = wbgtWork, work, acclimatized = true, clothing = 'work' }) {
  const M = metabolic(work);
  const cav = CLOTHING_ADJ[clothing];
  if (!Number.isFinite(wbgtWork) || !Number.isFinite(wbgtRest) || !(M > 0) || cav === undefined) {
    return { status: 'unknown', workMin: NaN, restMin: NaN, limit: NaN, twaWbgt: NaN, twaM: NaN, margin: NaN };
  }
  const lim = acclimatized ? rel : ral;
  const split = (workMin) => {
    const f = workMin / 60;
    const twaM = f * M + (1 - f) * METABOLIC_W.rest;
    const twaWbgt = f * wbgtWork + (1 - f) * wbgtRest + cav;
    const limit = lim(twaM);
    return { workMin, restMin: 60 - workMin, limit, twaWbgt, twaM, margin: limit - twaWbgt };
  };
  for (let w = 60; w >= MIN_WORK_MIN; w -= STEP_MIN) {
    const s = split(w);
    if (s.margin >= 0) return { status: w === 60 ? 'normal' : 'cycle', ...s };
  }
  const rest = split(0);
  return { status: rest.margin >= 0 ? 'stop' : 'danger', ...rest };
}

// TB MED 507 (2022) heat categories: lower WBGT bounds in degF
const CATEGORY_F = [78, 82, 85, 88, 90];

/** TB MED 507 heat category 1-5 (0 below 78 degF WBGT, null if unknown). */
export function heatCategory(wbgtC) {
  if (!Number.isFinite(wbgtC)) return null;
  const f = wbgtC * 1.8 + 32;
  let cat = 0;
  for (let i = 0; i < CATEGORY_F.length; i++) if (f >= CATEGORY_F[i]) cat = i + 1;
  return cat;
}

// TB MED 507 (2022) Table 3-3, water in qt/hr: rows = categories 1-5,
// columns = easy 250 W, moderate 425 W, heavy 600 W, very heavy 800 W.
const WATER_W = [250, 425, 600, 800];
const WATER_QT = [
  [0.5, 0.75, 0.75, 0.75],
  [0.5, 1, 1, 1],
  [0.75, 1, 1, 1],
  [0.75, 1.25, 1.25, 1.25],
  [1, 1.5, 1.5, 1.5],
];

/**
 * Water per hour for a work/rest plan: the TB MED 507 continuous-work row for
 * the heat category, interpolated at the plan's time-weighted metabolic rate
 * (clamped to 250-800 W), rounded up to 1/4 qt, capped at 1.5 qt.
 * @param {object} p  wbgt (degC, at the work site, clothing-adjusted), twaM (W)
 * @returns {{category:number|null, quarts:number|null, liters:number|null}}
 *   quarts/liters are null below category 1 (no table value: drink regularly).
 */
export function waterPerHour({ wbgt, twaM }) {
  const category = heatCategory(wbgt);
  if (!category || !(twaM > 0)) return { category, quarts: null, liters: null };
  const row = WATER_QT[category - 1];
  const m = Math.min(Math.max(twaM, WATER_W[0]), WATER_W[WATER_W.length - 1]);
  let i = 0;
  while (m > WATER_W[i + 1]) i++;
  const t = (m - WATER_W[i]) / (WATER_W[i + 1] - WATER_W[i]);
  const raw = row[i] + t * (row[i + 1] - row[i]);
  const quarts = Math.min(Math.ceil(raw * 4 - 1e-9) / 4, WATER_CAP_QT_HR);
  return { category, quarts, liters: quarts * QT_L };
}

/**
 * NIOSH 2016 Table 4-1: fraction of a usual day's heat exposure allowed on each
 * day of acclimatization. New workers: at most 20% on day 1, at most 20% more
 * each day. Experienced workers: 50, 60, 80, 100%.
 */
export function acclimatizationPlan(experienced) {
  return experienced ? [0.5, 0.6, 0.8, 1] : [0.2, 0.4, 0.6, 0.8, 1];
}

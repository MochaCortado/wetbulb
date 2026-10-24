/*
 * wbgt.mjs — outdoor Wet Bulb Globe Temperature from standard weather data.
 *
 * JavaScript port of WBGT Version 1.1 by James C. Liljegren (Argonne National
 * Laboratory), with the solar position routine by Nels Larson (PNNL).
 *
 * Changes from the original C (ported 2026 by Claude for Andrew Anderson):
 *   1. Translated to JavaScript (all arithmetic in IEEE doubles, as in the
 *      Lieblich 2016 C99/double revision of the original).
 *   2. calcWbgt takes and returns a plain object instead of pointer arguments.
 *   3. Added the optional `shade` input: the direct beam is removed after the
 *      solar parameters and stability class are computed, so meteorology is
 *      unchanged and only the instrument is shaded (diffuse light remains).
 *   4. Non-convergence returns NaN instead of -9999.
 *   5. If the original fixed-point iteration fails (it diverges for gale-force
 *      wind in sub-zero air, and cannot start at 0% humidity), the same heat
 *      balance is solved by bisection. NaN is returned only if that fails too.
 *      Where the original converges its result is returned unchanged.
 *   6. solarPosition: the original counted the current year's leap day twice
 *      in leap years after 2000 (2004, 2008, ... 2048), placing the sun one
 *      day ahead. Leap days are now counted only for years before the date.
 *
 * Reference: Liljegren, J. C., R. A. Carhart, P. Lawday, S. Tschopp, and
 *   R. Sharp: Modeling the Wet Bulb Globe Temperature Using Standard
 *   Meteorological Measurements. J. Occup. Environ. Hyg. 5:10, 645-655, 2008.
 *
 * ---------------------------------------------------------------------------
 *               Copyright © 2008, UChicago Argonne, LLC
 *                       All Rights Reserved
 *                        WBGT, Version 1.1
 *                     James C. Liljegren
 *              Decision & Information Sciences Division
 *                     OPEN SOURCE LICENSE
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.  Software changes,
 *    modifications, or derivative works, should be noted with comments and
 *    the author and organization's name.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * 3. Neither the names of UChicago Argonne, LLC or the Department of Energy
 *    nor the names of its contributors may be used to endorse or promote
 *    products derived from this software without specific prior written
 *    permission.
 * 4. The software and the end-user documentation included with the
 *    redistribution, if any, must include the following acknowledgment:
 *    "This product includes software produced by UChicago Argonne, LLC
 *    under Contract No. DE-AC02-06CH11357 with the Department of Energy."
 *
 * DISCLAIMER
 * THE SOFTWARE IS SUPPLIED "AS IS" WITHOUT WARRANTY OF ANY KIND.
 * NEITHER THE UNITED STATES GOVERNMENT, NOR THE UNITED STATES DEPARTMENT OF
 * ENERGY, NOR UCHICAGO ARGONNE, LLC, NOR ANY OF THEIR EMPLOYEES, MAKES ANY
 * WARRANTY, EXPRESS OR IMPLIED, OR ASSUMES ANY LEGAL LIABILITY OR
 * RESPONSIBILITY FOR THE ACCURACY, COMPLETENESS, OR USEFULNESS OF ANY
 * INFORMATION, DATA, APPARATUS, PRODUCT, OR PROCESS DISCLOSED, OR REPRESENTS
 * THAT ITS USE WOULD NOT INFRINGE PRIVATELY OWNED RIGHTS.
 * ---------------------------------------------------------------------------
 */

const PI = 3.1415926535897932;
const TWOPI = 6.2831853071795864;
const DEG_RAD = 0.017453292519943295;
const RAD_DEG = 57.295779513082323;
const SOLAR_CONST = 1367;
const STEFANB = 5.6696e-8;
const Cp = 1003.5;
const M_AIR = 28.97;
const M_H2O = 18.015;
const RATIO = (Cp * M_AIR) / M_H2O;
const R_GAS = 8314.34;
const R_AIR = R_GAS / M_AIR;
const Pr = Cp / (Cp + 1.25 * R_AIR);
const EMIS_WICK = 0.95;
const ALB_WICK = 0.4;
const D_WICK = 0.007;
const L_WICK = 0.0254;
const EMIS_GLOBE = 0.95;
const ALB_GLOBE = 0.05;
const D_GLOBE = 0.0508;
const EMIS_SFC = 0.999;
const ALB_SFC = 0.45;
const CZA_MIN = 0.00873;
const NORMSOLAR_MAX = 0.85;
const REF_HEIGHT = 2.0;
const MIN_SPEED = 0.13;
const CONVERGENCE = 0.02;
const MAX_ITER = 500;

// C modf: returns [fractional part, integral part], both carrying the sign of x.
function modf(x) {
  const i = Math.trunc(x);
  return [x - i, i];
}

/**
 * Outdoor WBGT and its components.
 * @param {object} p
 *   year, month (1-12), day (1-31), hour, minute — time of the observation
 *   gmt     offset of that time from UTC in hours (0 when the time is UTC)
 *   avg     averaging period of the inputs in minutes (0 = instantaneous)
 *   lat, lon  degrees (north and east positive)
 *   solar   global horizontal solar irradiance, W/m2
 *   pres    barometric pressure, hPa (= mb)
 *   tair    air temperature, degC
 *   rh      relative humidity, %
 *   speed   wind speed, m/s, measured at height zspeed
 *   zspeed  height of the wind measurement, m (2 skips the height correction)
 *   dT      vertical temperature difference (upper minus lower), degC; only
 *           its sign is used, for the night-time stability class
 *   urban   true for urban terrain (wind profile exponents)
 *   shade   true to shade the globe and wick from the direct beam
 *   _solver 'bisect' forces the fallback solver (tests only)
 * @returns {{wbgt:number,tg:number,tnwb:number,tpsy:number,estSpeed:number,cza:number,fdir:number,solar:number}}
 */
export function calcWbgt(p) {
  const { year, month, day, hour, minute = 0, gmt = 0, avg = 0, lat, lon, pres, tair, rh, zspeed = 10, dT = 0, urban = false, shade = false, _solver } = p;
  let solar = p.solar;
  let speed = p.speed;

  // convert time to GMT and center in avg period
  const hourGmt = hour - gmt + (minute - 0.5 * avg) / 60;
  const dday = day + hourGmt / 24;

  const sp = calcSolarParameters(year, month, dday, lat, lon, solar);
  solar = sp.solar;
  const cza = sp.cza;
  let fdir = sp.fdir;

  let estSpeed = speed;
  if (zspeed !== REF_HEIGHT) {
    const daytime = cza > 0;
    const stabilityClass = stabSrdt(daytime, speed, solar, dT);
    estSpeed = estWindSpeed(speed, zspeed, stabilityClass, urban);
    speed = estSpeed;
  }

  if (shade) {
    solar = solar * (1 - fdir);
    fdir = 0;
  }

  const tk = tair + 273.15;
  const rhf = 0.01 * rh;

  const tg = tglobe(tk, rhf, pres, speed, solar, fdir, cza, _solver);
  const tnwb = twb(tk, rhf, pres, speed, solar, fdir, cza, 1, _solver);
  const tpsy = twb(tk, rhf, pres, speed, solar, fdir, cza, 0, _solver);
  const wbgt = Number.isNaN(tg) || Number.isNaN(tnwb) ? NaN : 0.1 * tair + 0.2 * tg + 0.7 * tnwb;

  return { wbgt, tg, tnwb, tpsy, estSpeed, cza, fdir, solar };
}

// Cosine of the solar zenith angle and the direct-beam fraction; caps the
// irradiance at NORMSOLAR_MAX of the top-of-atmosphere value.
export function calcSolarParameters(year, month, day, lat, lon, solarIn) {
  let solar = solarIn;
  const pos = solarPosition(year, month, day, lat, lon);
  const cza = Math.cos((90 - pos.altitude) * DEG_RAD);
  let toasolar = (SOLAR_CONST * Math.max(0, cza)) / (pos.distance * pos.distance);
  let fdir;
  if (cza < CZA_MIN) toasolar = 0;
  if (toasolar > 0) {
    const normsolar = Math.min(solar / toasolar, NORMSOLAR_MAX);
    solar = normsolar * toasolar;
    if (normsolar > 0) {
      fdir = Math.exp(3 - 1.34 * normsolar - 1.65 / normsolar);
      fdir = Math.max(Math.min(fdir, 0.9), 0.0);
    } else fdir = 0;
  } else fdir = 0;
  return { solar, cza, fdir };
}

// Natural (rad = 1) or psychrometric (rad = 0) wet bulb temperature, degC.
function twb(Tair, rh, Pair, speed, solar, fdir, cza, rad, solver) {
  const a = 0.56; // from Bedingfield and Drew
  const Tsfc = Tair;
  const sza = Math.acos(cza);
  const eair = rh * esat(Tair);
  // wick temperature implied by the heat balance at wick temperature TwbPrev
  const step = (TwbPrev) => {
    const Tref = 0.5 * (TwbPrev + Tair);
    const h = hCylinderInAir(D_WICK, L_WICK, Tref, Pair, speed);
    const Fatm =
      STEFANB * EMIS_WICK * (0.5 * (emisAtm(Tair, rh) * Math.pow(Tair, 4) + EMIS_SFC * Math.pow(Tsfc, 4)) - Math.pow(TwbPrev, 4)) +
      (1 - ALB_WICK) * solar * ((1 - fdir) * (1 + (0.25 * D_WICK) / L_WICK) + fdir * (Math.tan(sza) / PI + (0.25 * D_WICK) / L_WICK) + ALB_SFC);
    const ewick = esat(TwbPrev);
    const density = (Pair * 100) / (R_AIR * Tref);
    const Sc = viscosity(Tref) / (density * diffusivity(Tref, Pair));
    return Tair - (evap(Tref) / RATIO) * ((ewick - eair) / (Pair - ewick)) * Math.pow(Pr / Sc, a) + (Fatm / h) * rad;
  };
  if (solver !== 'bisect') {
    let TwbPrev = dewPoint(eair); // first guess is the dew point temperature
    let TwbNew;
    let converged = false;
    let iter = 0;
    do {
      iter++;
      TwbNew = step(TwbPrev);
      if (Math.abs(TwbNew - TwbPrev) < CONVERGENCE) converged = true;
      TwbPrev = 0.9 * TwbPrev + 0.1 * TwbNew;
    } while (!converged && iter < MAX_ITER);
    if (converged) return TwbNew - 273.15;
  }
  // modification 5: T - step(T) increases with T
  return bisect((T) => T - step(T), Tair - 60, Tair + 20) - 273.15;
}

// Root of an increasing function on [lo, hi]; NaN if [lo, hi] does not bracket it.
function bisect(f, lo, hi) {
  if (!(f(lo) < 0 && f(hi) > 0)) return NaN;
  while (hi - lo > 1e-6) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// Convective heat transfer coefficient for a long cylinder in cross flow, W/(m2 K).
function hCylinderInAir(diameter, length, Tair, Pair, speed) {
  const a = 0.56, b = 0.281, c = 0.4; // Bedingfield and Drew
  const density = (Pair * 100) / (R_AIR * Tair);
  const Re = (Math.max(speed, MIN_SPEED) * density * diameter) / viscosity(Tair);
  const Nu = b * Math.pow(Re, 1 - c) * Math.pow(Pr, 1 - a);
  return (Nu * thermalCond(Tair)) / diameter;
}

// Globe temperature, degC.
function tglobe(Tair, rh, Pair, speed, solar, fdir, cza, solver) {
  const Tsfc = Tair;
  // fourth power of the globe temperature implied by the heat balance at TglobePrev
  const step4 = (TglobePrev) => {
    const Tref = 0.5 * (TglobePrev + Tair);
    const h = hSphereInAir(D_GLOBE, Tref, Pair, speed);
    return (
      0.5 * (emisAtm(Tair, rh) * Math.pow(Tair, 4) + EMIS_SFC * Math.pow(Tsfc, 4)) -
      (h / (STEFANB * EMIS_GLOBE)) * (TglobePrev - Tair) +
      (solar / (2 * STEFANB * EMIS_GLOBE)) * (1 - ALB_GLOBE) * (fdir * (1 / (2 * cza) - 1) + 1 + ALB_SFC)
    );
  };
  if (solver !== 'bisect') {
    let TglobePrev = Tair; // first guess is the air temperature
    let TglobeNew;
    let converged = false;
    let iter = 0;
    do {
      iter++;
      TglobeNew = Math.pow(step4(TglobePrev), 0.25);
      if (Math.abs(TglobeNew - TglobePrev) < CONVERGENCE) converged = true;
      TglobePrev = 0.9 * TglobePrev + 0.1 * TglobeNew;
    } while (!converged && iter < MAX_ITER);
    if (converged) return TglobeNew - 273.15;
  }
  // modification 5: T^4 - step4(T) increases with T (and stays finite where step4 < 0)
  return bisect((T) => Math.pow(T, 4) - step4(T), Tair - 100, Tair + 200) - 273.15;
}

// Convective heat transfer coefficient for flow around a sphere, W/(m2 K).
function hSphereInAir(diameter, Tair, Pair, speed) {
  const density = (Pair * 100) / (R_AIR * Tair);
  const Re = (Math.max(speed, MIN_SPEED) * density * diameter) / viscosity(Tair);
  const Nu = 2.0 + 0.6 * Math.sqrt(Re) * Math.pow(Pr, 0.3333);
  return (Nu * thermalCond(Tair)) / diameter;
}

// Saturation vapour pressure over liquid water, hPa (Buck 1981), with the
// moist-air enhancement factor for pressures above 800 hPa.
export function esat(tk) {
  const y = (tk - 273.15) / (tk - 32.18);
  return 1.004 * 6.1121 * Math.exp(17.502 * y);
}

// Dew point, K, from vapour pressure in hPa.
function dewPoint(e) {
  const z = Math.log(e / (6.1121 * 1.004));
  return 273.15 + (240.97 * z) / (17.502 - z);
}

// Viscosity of air, kg/(m s).
function viscosity(Tair) {
  const sigma = 3.617, epsKappa = 97.0;
  const Tr = Tair / epsKappa;
  const omega = ((Tr - 2.9) / 0.4) * -0.034 + 1.048;
  return (2.6693e-6 * Math.sqrt(M_AIR * Tair)) / (sigma * sigma * omega);
}

// Thermal conductivity of air, W/(m K).
function thermalCond(Tair) {
  return (Cp + 1.25 * R_AIR) * viscosity(Tair);
}

// Diffusivity of water vapour in air, m2/s.
function diffusivity(Tair, Pair) {
  const PcritAir = 36.4, PcritH2o = 218, TcritAir = 132, TcritH2o = 647.3, a = 3.64e-4, b = 2.334;
  const Pcrit13 = Math.pow(PcritAir * PcritH2o, 1 / 3);
  const Tcrit512 = Math.pow(TcritAir * TcritH2o, 5 / 12);
  const Tcrit12 = Math.sqrt(TcritAir * TcritH2o);
  const Mmix = Math.sqrt(1 / M_AIR + 1 / M_H2O);
  const Patm = Pair / 1013.25;
  return ((a * Math.pow(Tair / Tcrit12, b) * Pcrit13 * Tcrit512 * Mmix) / Patm) * 1e-4;
}

// Heat of evaporation, J/kg, for 283-313 K.
function evap(Tair) {
  return ((313.15 - Tair) / 30) * -71100 + 2.4073e6;
}

// Atmospheric emissivity (Oke).
function emisAtm(Tair, rh) {
  const e = rh * esat(Tair);
  return 0.575 * Math.pow(e, 0.143);
}

// Low-precision solar coordinates (Astronomical Almanac 1990), N. Larson.
// day is day-of-month plus fraction of a day in UT. Returns the apparent
// altitude in degrees (refraction added, as in Liljegren's version) and the
// Earth-Sun distance in AU.
export function solarPosition(year, month, day, latitude, longitude) {
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new RangeError('lat/lon out of range');
  if (year < 1950 || year > 2049) throw new RangeError('year out of range');
  if (month < 1 || month > 12 || day < 0 || day > 33) throw new RangeError('date out of range');
  const pressure = 1013.25, temp = 15.0;

  const daynumber = daynum(year, month, Math.trunc(day));
  const deltaYears = year - 2000;
  // whole days from 2000 January 0 (modification 6: leap days of 2000..year-1 only)
  const leapDays = year > 2000 ? Math.trunc((deltaYears - 1) / 4) + 1 : Math.trunc(deltaYears / 4);
  const deltaDays = deltaYears * 365 + leapDays + daynumber;
  let daysJ2000 = deltaDays - 1.5;
  const centJ2000 = daysJ2000 / 36525.0;
  let ut = modf(day)[0];
  daysJ2000 += ut;
  ut *= 24.0;

  let meanAnomaly = 357.528 + 0.9856003 * daysJ2000;
  let meanLongitude = 280.46 + 0.9856474 * daysJ2000;
  meanAnomaly = modf(meanAnomaly / 360.0)[0] * TWOPI;
  meanLongitude = modf(meanLongitude / 360.0)[0] * TWOPI;
  const meanObliquity = (23.439 - 4.0e-7 * daysJ2000) * DEG_RAD;
  const eclipticLong = (1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2.0 * meanAnomaly)) * DEG_RAD + meanLongitude;
  const distance = 1.00014 - 0.01671 * Math.cos(meanAnomaly) - 0.00014 * Math.cos(2.0 * meanAnomaly);

  let apRa = Math.atan2(Math.cos(meanObliquity) * Math.sin(eclipticLong), Math.cos(eclipticLong));
  if (apRa < 0) apRa += TWOPI;
  apRa = modf(apRa / TWOPI)[0] * 24.0;
  const apDec = Math.asin(Math.sin(meanObliquity) * Math.sin(eclipticLong));

  let gmst0h = 24110.54841 + centJ2000 * (8640184.812866 + centJ2000 * (0.093104 - centJ2000 * 6.2e-6));
  gmst0h = modf(gmst0h / 3600.0 / 24.0)[0] * 24.0;
  if (gmst0h < 0) gmst0h += 24.0;

  let lmst = gmst0h + ut * 1.00273790934 + longitude / 15.0;
  lmst = modf(lmst / 24.0)[0] * 24.0;
  if (lmst < 0) lmst += 24.0;

  let localHa = lmst - apRa;
  if (localHa < -12.0) localHa += 24.0;
  else if (localHa > 12.0) localHa -= 24.0;

  const lat = latitude * DEG_RAD;
  localHa = (localHa / 24.0) * TWOPI;

  let altitude = Math.asin(Math.sin(apDec) * Math.sin(lat) + Math.cos(apDec) * Math.cos(localHa) * Math.cos(lat));
  const tanAlt = Math.abs(altitude) < 1.57079615 ? Math.tan(altitude) : 6.0e6;
  altitude *= RAD_DEG;

  let refraction;
  if (altitude < -1.0 || tanAlt === 6.0e6) refraction = 0.0;
  else if (altitude < 19.225) {
    refraction = (0.1594 + altitude * (0.0196 + 0.00002 * altitude)) * pressure;
    refraction /= (1.0 + altitude * (0.505 + 0.0845 * altitude)) * (273.0 + temp);
  } else refraction = (0.00452 * (pressure / (273.0 + temp))) / tanAlt;

  return { altitude: altitude + refraction, distance, declination: apDec * RAD_DEG };
}

// Sequential day number within a Gregorian year (Jan 1 = 1).
function daynum(year, month, day) {
  const begmonth = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const leapyr = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  let dnum = begmonth[month] + day;
  if (leapyr && month > 2) dnum += 1;
  return dnum;
}

// 2-m wind speed from a measurement at height zspeed (EPA-454/5-99-005 6.2.5).
function estWindSpeed(speed, zspeed, stabilityClass, urban) {
  const urbanExp = [0.15, 0.15, 0.2, 0.25, 0.3, 0.3];
  const ruralExp = [0.07, 0.07, 0.1, 0.15, 0.35, 0.55];
  const exponent = urban ? urbanExp[stabilityClass - 1] : ruralExp[stabilityClass - 1];
  return Math.max(speed * Math.pow(REF_HEIGHT / zspeed, exponent), MIN_SPEED);
}

// Pasquill stability class by the solar radiation / delta-T method.
function stabSrdt(daytime, speed, solar, dT) {
  const lsrdt = [
    [1, 1, 2, 4, 0, 5, 6, 0],
    [1, 2, 3, 4, 0, 5, 6, 0],
    [2, 2, 3, 4, 0, 4, 4, 0],
    [3, 3, 4, 4, 0, 0, 0, 0],
    [3, 4, 4, 4, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ];
  let i, j;
  if (daytime) {
    if (solar >= 925) j = 0;
    else if (solar >= 675) j = 1;
    else if (solar >= 175) j = 2;
    else j = 3;
    if (speed >= 6) i = 4;
    else if (speed >= 5) i = 3;
    else if (speed >= 3) i = 2;
    else if (speed >= 2) i = 1;
    else i = 0;
  } else {
    j = dT >= 0 ? 6 : 5;
    if (speed >= 2.5) i = 2;
    else if (speed >= 2) i = 1;
    else i = 0;
  }
  return lsrdt[i][j];
}

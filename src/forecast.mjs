/*
 * forecast.mjs — Open-Meteo place search and hourly forecast, with the last
 * forecast kept in localStorage for offline use. Weather data by
 * Open-Meteo.com (CC BY 4.0). Zero dependencies.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const VARS = ['temperature_2m', 'relative_humidity_2m', 'wind_speed_10m', 'surface_pressure', 'shortwave_radiation'];
const CACHE_KEY = 'heatplan:forecast';
const SAME_PLACE_DEG = 0.05;

// localStorage that never throws (private mode, blocked storage, quota).
export const safeStorage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

export function forecastUrl(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: VARS.join(','),
    wind_speed_unit: 'ms', timezone: 'auto', timeformat: 'unixtime', forecast_days: '8',
  });
  return `${FORECAST_URL}?${q}`;
}

/** Up to 8 places matching `name`: [{name, admin1, country, cc, lat, lon, tz}]. */
export async function searchPlaces(name, { fetchFn = fetch, lang = 'en' } = {}) {
  const q = new URLSearchParams({ name, count: '8', language: lang, format: 'json' });
  const res = await fetchFn(`${GEOCODE_URL}?${q}`);
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  const j = await res.json();
  return (j.results || []).map((r) => ({
    name: r.name, admin1: r.admin1 || '', country: r.country || '', cc: r.country_code || '',
    lat: r.latitude, lon: r.longitude, tz: r.timezone || '',
  }));
}

/** Turn an Open-Meteo response into column arrays; hours with missing values stay null. */
export function parseForecast(j) {
  const h = j && j.hourly;
  if (!h || !Array.isArray(h.time) || h.time.length < 2) throw new Error('Forecast has no hourly data');
  const col = (k) => (Array.isArray(h[k]) && h[k].length === h.time.length ? h[k] : h.time.map(() => null));
  return {
    lat: j.latitude, lon: j.longitude, tz: j.timezone || 'UTC', elevation: j.elevation,
    time: h.time, tair: col('temperature_2m'), rh: col('relative_humidity_2m'), wind: col('wind_speed_10m'),
    pres: col('surface_pressure'), solar: col('shortwave_radiation'),
  };
}

/**
 * Forecast for a place. On network failure falls back to the cached forecast
 * for the same place. Returns {...parseForecast, fetchedAt, fromCache}.
 */
export async function loadForecast(lat, lon, { fetchFn = fetch, storage = safeStorage, now = Date.now() } = {}) {
  try {
    const res = await fetchFn(forecastUrl(lat, lon));
    if (!res.ok) throw new Error(`Forecast request failed (${res.status})`);
    const fc = { ...parseForecast(await res.json()), fetchedAt: now, fromCache: false, req: { lat, lon } };
    storage.set(CACHE_KEY, JSON.stringify(fc));
    return fc;
  } catch (err) {
    const cached = cachedForecast(lat, lon, storage);
    if (cached) return { ...cached, fromCache: true, error: String(err.message || err) };
    throw err;
  }
}

/** The stored forecast if it was requested for (about) this place, else null. */
export function cachedForecast(lat, lon, storage = safeStorage) {
  let fc = null;
  try { fc = JSON.parse(storage.get(CACHE_KEY)); } catch { return null; }
  if (!fc || !fc.req || !Array.isArray(fc.time)) return null;
  if (Math.abs(fc.req.lat - lat) > SAME_PLACE_DEG || Math.abs(fc.req.lon - lon) > SAME_PLACE_DEG) return null;
  return fc;
}

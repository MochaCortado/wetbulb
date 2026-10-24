# Heat Plan

Work, rest and water plan for outdoor work in heat, from the weather forecast. Anywhere on Earth, free, no sign-up.

**https://mochacortado.github.io/wetbulb/**

Forecast estimate, not a measurement. Outdoor work only.

## What it does

- Estimates heat stress (WBGT, wet bulb globe temperature) for every forecast hour, in sun and in shade.
- Turns it into minutes of work and rest in each hour, and how much to drink, for each crew: work rate, sun or shade, where breaks are taken, workers used to the heat or new, clothing.
- Shows the hour now, a 7-day outlook, and the plan for a shift.
- Copies the plan as text for messaging apps, makes a link that rebuilds the page, prints a one-page plan, and keeps the last forecast for use offline.

## Method

- **WBGT:** Liljegren et al. (2008), *J. Occup. Environ. Hyg.* 5:645–655, ported from Argonne's WBGT v1.1 C code (`src/wbgt.mjs`). Hourly forecast from Open-Meteo: air temperature, humidity, 10 m wind, surface pressure, and the hour's mean solar radiation. Shade removes the direct beam. Forecast wind below 0.62 m/s is raised to 0.62 m/s, as in KNMI's operational WBGT.
- **Work and rest:** NIOSH (2016) Criteria for a Recommended Standard, Occupational Exposure to Heat and Hot Environments, DHHS (NIOSH) 2016-106. REL for workers used to heat, RAL for new or higher-risk workers, as hourly time-weighted averages that include breaks, in 15-minute steps. Clothing adjustments from NIOSH Table 3-2.
- **Water:** US Army TB MED 507 (2022), Table 3-3, at the hour's time-weighted work rate. Never more than 1.5 qt (1.4 L) an hour or 12 qt (11 L) a day.
- **Acclimatization and first aid:** NIOSH (2016) Tables 4-1 and 4-3.

Changes from the original C code are listed at the top of `src/wbgt.mjs`. They include a fix for its leap-year date error (2004, 2008, … 2048 used the next day's sun) and a fallback solver where its iteration fails.

## Files

| Path | |
|-|-|
| `index.html`, `app.css`, `src/app.mjs` | The page |
| `src/wbgt.mjs` | WBGT model |
| `src/guidance.mjs` | Exposure limits, work/rest, water, acclimatization |
| `src/plan.mjs` | Forecast hours to plans, share text and links |
| `src/forecast.mjs` | Open-Meteo forecast and place search, offline copy |
| `sw.js`, `manifest.webmanifest` | Offline app shell |
| `tests/` | Browser tests: open `tests/` on any static server |
| `ref/` | The C reference used to check the port |

No build step and no dependencies. Serve the folder with any static file server.

## Credits

- WBGT model: James C. Liljegren, Argonne National Laboratory. Solar position: Nels Larson, Pacific Northwest National Laboratory. This product includes software produced by UChicago Argonne, LLC under Contract No. DE-AC02-06CH11357 with the Department of Energy.
- Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0).
- Andrew Anderson ([@mochacortado](https://x.com/mochacortado)).

## Licence

MIT, except `src/wbgt.mjs` and `ref/`, which keep the UChicago Argonne licence (see `LICENSE`).

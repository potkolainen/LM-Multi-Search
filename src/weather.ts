/**
 * Tiny wttr.in client. No API key, no deps, no JS rendering needed.
 *
 * wttr.in returns plain text when called with `?format=…` or `?T` (terminal).
 * We use the "j1" JSON endpoint for structure, then format a compact text
 * summary so the model gets clean, low-token output.
 */

export interface WeatherOptions {
  userAgent: string;
  timeoutMs: number;
  units?: "metric" | "imperial";
  lang?: string;
}

export interface WeatherResult {
  location: string;
  resolved_location?: string;
  current: {
    description: string;
    temperature: string;
    feels_like: string;
    humidity: string;
    wind: string;
    observed_local_time?: string;
  };
  forecast: Array<{
    date: string;
    summary: string;
    min: string;
    max: string;
    sunrise?: string;
    sunset?: string;
  }>;
  source: string;
  source_url: string;
}

function abortableFetch(url: string, opts: { userAgent: string; timeoutMs: number }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  return fetch(url, {
    signal: ctl.signal,
    headers: {
      "User-Agent": opts.userAgent,
      Accept: "application/json",
    },
  }).finally(() => clearTimeout(timer));
}

export async function getWeather(
  location: string,
  opts: WeatherOptions,
): Promise<WeatherResult | { error: string; source: string; source_url: string }> {
  const loc = location.trim();
  const units = opts.units ?? "metric";
  const lang = opts.lang ?? "en";
  const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1&lang=${encodeURIComponent(lang)}`;

  let res: Response;
  try {
    res = await abortableFetch(url, opts);
  } catch (e: any) {
    return {
      error: `wttr.in request failed: ${e?.message ?? String(e)}`,
      source: "wttr.in",
      source_url: url,
    };
  }
  if (!res.ok) {
    return {
      error: `wttr.in returned HTTP ${res.status}`,
      source: "wttr.in",
      source_url: url,
    };
  }

  let data: any;
  try {
    data = await res.json();
  } catch (e: any) {
    return {
      error: `wttr.in returned non-JSON (location may be unknown): ${e?.message ?? String(e)}`,
      source: "wttr.in",
      source_url: url,
    };
  }

  const c = data?.current_condition?.[0];
  const area = data?.nearest_area?.[0];
  if (!c) {
    return {
      error: "wttr.in returned no current_condition (unknown location?)",
      source: "wttr.in",
      source_url: url,
    };
  }

  const tempC = c.temp_C;
  const tempF = c.temp_F;
  const feelsC = c.FeelsLikeC;
  const feelsF = c.FeelsLikeF;
  const windKph = c.windspeedKmph;
  const windMph = c.windspeedMiles;
  const windDir = c.winddir16Point;
  const description = c.weatherDesc?.[0]?.value ?? "Unknown";
  const humidity = `${c.humidity}%`;
  const localObs = c.localObsDateTime;

  const resolved =
    area &&
    [area.areaName?.[0]?.value, area.region?.[0]?.value, area.country?.[0]?.value]
      .filter(Boolean)
      .join(", ");

  const fmtTemp = (cVal: string, fVal: string) =>
    units === "imperial" ? `${fVal}°F` : `${cVal}°C`;
  const fmtWind = (k: string, m: string, dir: string) =>
    units === "imperial" ? `${m} mph ${dir}` : `${k} km/h ${dir}`;

  const forecast = (data.weather ?? []).slice(0, 3).map((d: any) => {
    const hourly = d.hourly ?? [];
    const middayChunk = hourly[Math.min(4, hourly.length - 1)] ?? hourly[0];
    const summary = middayChunk?.weatherDesc?.[0]?.value ?? "Unknown";
    return {
      date: d.date,
      summary,
      min: fmtTemp(d.mintempC, d.mintempF),
      max: fmtTemp(d.maxtempC, d.maxtempF),
      sunrise: d.astronomy?.[0]?.sunrise,
      sunset: d.astronomy?.[0]?.sunset,
    };
  });

  return {
    location: loc,
    resolved_location: resolved || undefined,
    current: {
      description,
      temperature: fmtTemp(tempC, tempF),
      feels_like: fmtTemp(feelsC, feelsF),
      humidity,
      wind: fmtWind(windKph, windMph, windDir),
      observed_local_time: localObs,
    },
    forecast,
    source: "wttr.in",
    source_url: `https://wttr.in/${encodeURIComponent(loc)}`,
  };
}

// Weather connector: forecasts from Open-Meteo (keyless), through the SSRF-guarded fetcher.
import { z } from 'zod';
import type { GarnetConfig } from '../config/index.ts';
import { GarnetError, type ToolDefinition } from '../contracts/index.ts';
import { apiMessage, clean, clip, fetchJson, type ConnectorDeps } from './http.ts';

export type WeatherSettings = GarnetConfig['connectors']['weather'];
export type WeatherInput = { location?: string | undefined; latitude?: number | undefined; longitude?: number | undefined; days?: number | undefined };

export const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** WMO weather interpretation codes, as Open-Meteo documents them. */
const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle', 56: 'freezing drizzle', 57: 'dense freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

export function weatherTool(settings: WeatherSettings, deps: ConnectorDeps): ToolDefinition<WeatherInput> {
  const input = z.object({
    location: z.string().min(1).max(100).optional().describe(`Place name, e.g. "Lisbon" or "Portland, Oregon".${settings.location ? ` Default: ${settings.location}.` : ''}`),
    latitude: z.number().min(-90).max(90).optional().describe('Latitude, instead of a place name (with longitude).'),
    longitude: z.number().min(-180).max(180).optional().describe('Longitude, instead of a place name (with latitude).'),
    days: z.number().int().min(1).max(7).optional().describe('Days of forecast, starting today (1 to 7; default 3).'),
  });
  const imperial = settings.units === 'imperial';
  const u = imperial ? { t: '°F', w: 'mph', p: 'in' } : { t: '°C', w: 'km/h', p: 'mm' };

  const place = (i: WeatherInput): string | null => {
    if (i.latitude !== undefined || i.longitude !== undefined) {
      if (i.latitude === undefined || i.longitude === undefined) throw new GarnetError('invalid_input', 'Give both latitude and longitude, or a location name.');
      return null;
    }
    const name = i.location ?? settings.location;
    if (!name) throw new GarnetError('invalid_input', 'Say which place (location), or ask the owner to set connectors.weather.location.');
    return name;
  };
  const geocodeUrl = (name: string) => `${GEOCODING_URL}?${new URLSearchParams({ name, count: '1', language: 'en', format: 'json' })}`;
  const forecastUrl = (lat: number, lon: number, days: number) =>
    `${FORECAST_URL}?${new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max',
      timezone: 'auto',
      forecast_days: String(days),
      ...(imperial ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' } : {}),
    })}`;

  const get = async (url: string, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const { res, data } = await fetchJson(deps.fetcher, url, { signal, headers: { accept: 'application/json' } });
    if (res.status < 200 || res.status >= 300) {
      const msg = apiMessage(data) || clip(clean((data as { reason?: unknown } | null)?.reason), 200);
      throw new GarnetError(res.status >= 500 || res.status === 429 ? 'provider_transient' : 'tool_failed', `Open-Meteo answered ${res.status}${msg ? `: ${msg}` : ''}.`);
    }
    return (data ?? {}) as Record<string, unknown>;
  };

  return {
    name: 'weather',
    version: 1,
    description: 'Weather (connector): current conditions and a daily forecast (up to 7 days) for a place, from Open-Meteo.',
    input,
    capability: 'net.fetch',
    targets: (i) => {
      const name = place(i);
      return name ? [geocodeUrl(name), FORECAST_URL] : [FORECAST_URL];
    },
    summarize: (i) => `weather: forecast for ${place(i) ?? `${i.latitude}, ${i.longitude}`} from Open-Meteo`,
    idempotent: true,
    untrustedOutput: true,
    timeoutMs: 30_000,
    async run(i, ctx) {
      const name = place(i);
      let lat = i.latitude!;
      let lon = i.longitude!;
      let label = `${lat}, ${lon}`;
      if (name) {
        const geo = await get(geocodeUrl(name), ctx.signal);
        const hit = (geo.results as { name?: string; latitude?: number; longitude?: number; country?: string; admin1?: string }[] | undefined)?.[0];
        if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') throw new GarnetError('invalid_input', `No place called "${clip(name, 100)}" was found. Try another spelling or add the country.`);
        lat = hit.latitude;
        lon = hit.longitude;
        label = [hit.name, hit.admin1, hit.country].map((x) => clip(clean(x), 60)).filter(Boolean).join(', ');
      }
      const f = await get(forecastUrl(lat, lon, i.days ?? 3), ctx.signal);
      const cur = f.current as Record<string, number> | undefined;
      const daily = f.daily as Record<string, (number | string | null)[]> | undefined;
      const lines = [`Weather for ${label} (${lat.toFixed(2)}, ${lon.toFixed(2)}; local time zone ${clean(f.timezone) || '?'}):`];
      if (cur) {
        lines.push(
          `Now: ${num(cur.temperature_2m)}${u.t} (feels like ${num(cur.apparent_temperature)}${u.t}), ${WMO[cur.weather_code ?? -1] ?? 'unknown conditions'}, wind ${num(cur.wind_speed_10m)} ${u.w}, precipitation ${num(cur.precipitation)} ${u.p}.`,
        );
      }
      const days = (daily?.time ?? []) as string[];
      days.forEach((day, k) => {
        const at = (key: string) => daily?.[key]?.[k] ?? null;
        lines.push(
          `- ${clean(day)}: ${WMO[Number(at('weather_code'))] ?? 'unknown'}, ${num(at('temperature_2m_min'))} to ${num(at('temperature_2m_max'))}${u.t}, rain chance ${num(at('precipitation_probability_max'))}%, precipitation ${num(at('precipitation_sum'))} ${u.p}, wind up to ${num(at('wind_speed_10m_max'))} ${u.w}`,
        );
      });
      return { content: lines.join('\n'), untrusted: { source: `weather (Open-Meteo) for ${clip(label, 80)}` }, data: { latitude: lat, longitude: lon } };
    },
  };
}

function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '?';
}

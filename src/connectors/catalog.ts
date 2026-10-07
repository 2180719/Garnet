import { CONNECTORS, type ConnectorName, type GarnetConfig } from '../config/index.ts';
import type { Capability, ToolDefinition } from '../contracts/index.ts';
import { calendarTool } from './calendar.ts';
import { githubTool } from './github.ts';
import type { ConnectorDeps } from './http.ts';
import { weatherTool } from './weather.ts';

export type ConnectorSettings = GarnetConfig['connectors'];

/** What the CLI, doctor and docs show about a connector, without building it. */
export type ConnectorInfo = {
  name: ConnectorName;
  /** The tool it adds (one per connector, to keep the per-session tool set small). */
  tool: string;
  summary: string;
  /** Capabilities its calls need, in words. */
  needs: (s: ConnectorSettings) => Capability[];
  /** Hosts it talks to (for web.allowHosts). */
  hosts: (s: ConnectorSettings) => string[];
  /** Secret names it reads and whether the connector is useless without them. */
  secrets: (s: ConnectorSettings) => { name: string; required: boolean; why: string }[];
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const CONNECTOR_INFO: Record<ConnectorName, ConnectorInfo> = {
  calendar: {
    name: 'calendar',
    tool: 'calendar',
    summary: 'Read-only events from your calendar\'s ICS feed (Google, iCloud, Fastmail, Outlook, Nextcloud), in your time zone.',
    needs: () => ['net.fetch'],
    hosts: () => ['the host of your feed address'],
    secrets: (s) => [{ name: s.calendar.urlEnv, required: true, why: 'the private feed address' }],
  },
  github: {
    name: 'github',
    tool: 'github',
    summary: 'Search, list and read GitHub issues and pull requests, read notifications; optionally comment (connectors.github.write).',
    needs: (s) => (s.github.write ? ['net.fetch', 'message.send'] : ['net.fetch']),
    hosts: (s) => [hostOf(s.github.apiUrl)],
    secrets: (s) => [{ name: s.github.tokenEnv, required: false, why: 'a token (optional for public repositories; needed for private ones, notifications and comments)' }],
  },
  weather: {
    name: 'weather',
    tool: 'weather',
    summary: 'Current weather and a 7-day forecast from Open-Meteo (keyless).',
    needs: () => ['net.fetch'],
    hosts: () => ['geocoding-api.open-meteo.com', 'api.open-meteo.com'],
    secrets: () => [],
  },
};

/** Builds the tool for each named connector. */
export function connectorTools(names: readonly ConnectorName[], settings: ConnectorSettings, deps: ConnectorDeps): { connector: ConnectorName; tool: ToolDefinition }[] {
  return names.map((name) => {
    switch (name) {
      case 'calendar':
        return { connector: name, tool: calendarTool(settings.calendar, deps) as ToolDefinition };
      case 'github':
        return { connector: name, tool: githubTool(settings.github, deps) as ToolDefinition };
      case 'weather':
        return { connector: name, tool: weatherTool(settings.weather, deps) as ToolDefinition };
    }
  });
}

export const CONNECTOR_NAMES: readonly ConnectorName[] = CONNECTORS;

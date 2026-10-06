export { TelegramChannel, type TelegramOptions } from './telegram.ts';
export { SignalChannel, type SignalOptions } from './signal.ts';
export { DiscordChannel, type DiscordOptions } from './discord.ts';

/** Largest file each channel's adapter sends (the platform's bot upload limit), for tools that queue files. */
export const UPLOAD_LIMITS: Readonly<Record<string, number>> = {
  telegram: 50 * 1024 * 1024,
  discord: 10 * 1024 * 1024,
  signal: 100 * 1024 * 1024,
};

/** Return today for the existing Fri/Sat/Sun preset, otherwise its next Friday. */
export function localSeedDate(now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekday = date.getUTCDay();
  const daysUntilFriday = (5 - weekday + 7) % 7;
  if (weekday === 0 || weekday >= 5) return date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + daysUntilFriday);
  return date.toISOString().slice(0, 10);
}

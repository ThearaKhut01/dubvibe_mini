// Reads DUBVIBE_MINI_<name>, falling back to the legacy YOUDUB_<name> so existing .env files keep working.
export function readEnv(name: string, fallback = ''): string {
  for (const key of [`DUBVIBE_MINI_${name}`, `YOUDUB_${name}`]) {
    const value = process.env[key]
    if (value?.trim()) return value
  }
  return fallback
}

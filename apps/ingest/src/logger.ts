/** Minimal structured logger — JSON lines, no secrets. */
type Level = 'debug' | 'info' | 'warn' | 'error';

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

/** Strip credentials from a connection URL for safe logging. */
export function redactUrl(url: string): string {
  // Remove any userinfo entirely — credentials never appear in logs at all.
  return url.replace(/\/\/[^@/]*@/, '//');
}

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Set it in .env or the environment.`);
  return value;
}

export function phone(value: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(value)) throw new Error('Use an E.164 phone number, for example +12025550123.');
  return value;
}

export function webhookOrigin(): string {
  const value = required('WEBHOOK_BASE_URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('WEBHOOK_BASE_URL must be an HTTPS origin without a path, query, or credentials.');
  }
  return url.origin;
}

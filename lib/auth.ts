/** Basic-auth and cron-secret checks. Works in the proxy and in route handlers. */

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** True if the Authorization header carries DASHBOARD_USER/DASHBOARD_PASSWORD. Fails closed if unset. */
export function checkBasicAuth(header: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const user = env.DASHBOARD_USER;
  const pass = env.DASHBOARD_PASSWORD;
  if (!user || !pass || !header?.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}

/** Vercel cron sends "Authorization: Bearer $CRON_SECRET". Fails closed if unset. */
export function checkCronSecret(header: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const secret = env.CRON_SECRET;
  return !!secret && !!header && safeEqual(header, `Bearer ${secret}`);
}

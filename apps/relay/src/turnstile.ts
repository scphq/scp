const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(secret: string, token: string, remoteIp: string | null): Promise<boolean> {
  if (!secret || !token || token.length > 2048) return false;
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body });
    if (!res.ok) return false;
    const out = (await res.json()) as { success?: unknown };
    return out.success === true;
  } catch {
    return false;
  }
}

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace;
  EMAIL?: SendEmail;
  /** `cloudflare` (default), `resend` or `log` */
  MAILER?: string;
  MAIL_FROM?: string;
  RESEND_API_KEY?: string;
  SESSION_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
}

export type Role = "owner" | "admin" | "member";

export interface User {
  id: string;
  email: string;
}

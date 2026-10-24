import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
export interface Env {
  SCP_LIMITS?: string;
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  RELAY_ORIGIN: string;
  HUB: DurableObjectNamespace;
  EMAIL?: SendEmail;
  /** `cloudflare` (default), `resend` or `log` */
  MAILER?: string;
  MAIL_FROM?: string;
  RESEND_API_KEY?: string;
  SESSION_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
  /** the relay judge's model key; OPENROUTER_API_KEY when unset */
  JUDGE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** the judge model's provider, default `openrouter` */
  JUDGE_PROVIDER?: string;
  /** the model name at JUDGE_PROVIDER; without it, or without a key, no org is judged */
  JUDGE_MODEL?: string;
}

export type Role = "owner" | "admin" | "member";

export interface User {
  id: string;
  email: string;
}

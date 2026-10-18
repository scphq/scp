import type { Env } from "./env";
import { HttpError } from "./util";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Cloudflare Email Service through the `send_email` binding */
export function cloudflareMailer(binding: SendEmail, from: string): Mailer {
  return {
    async send(mail) {
      await binding.send({ from, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}

export function resendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(mail) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
      });
      if (!res.ok) throw new Error(`resend: ${res.status}`);
    },
  };
}

/** prints each mail as one `scp-relay mail <json>` line; local dev and tests only */
export const logMailer: Mailer = {
  async send(mail) {
    console.log(`scp-relay mail ${JSON.stringify(mail)}`);
  },
};

export function mailerFor(env: Env): Mailer {
  const from = env.MAIL_FROM || "login@scp.dev";
  switch (env.MAILER || "cloudflare") {
    case "cloudflare":
      if (!env.EMAIL) throw new HttpError(500, "mailer_unconfigured", "The EMAIL send_email binding is missing.");
      return cloudflareMailer(env.EMAIL, from);
    case "resend":
      if (!env.RESEND_API_KEY) throw new HttpError(500, "mailer_unconfigured", "RESEND_API_KEY is not set.");
      return resendMailer(env.RESEND_API_KEY, from);
    case "log":
      return logMailer;
    default:
      throw new HttpError(500, "mailer_unconfigured", `Unknown MAILER ${env.MAILER}.`);
  }
}

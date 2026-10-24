import { HttpJudgeClient, type JudgePolicy, judgeModel } from "@scp-dev/core";
import type { HubJudgeOptions } from "@scp-dev/hub";
import type { Env } from "../env";

/** the Worker tells the hub whether its org turned the judge on: `1` or `0`, set by the Worker only */
export const JUDGE_HEADER = "x-scp-hub-judge";

const KEY_ENV = "JUDGE_API_KEY";

/** the hosted relay's judge from its env, or null when a model, a key or a known provider is missing: then nothing is judged */
export function judgeSetup(env: Env): { policy: JudgePolicy; options: HubJudgeOptions } | null {
  const model = env.JUDGE_MODEL?.trim();
  const key = env.JUDGE_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();
  if (!model || !key) return null;
  const id = `${env.JUDGE_PROVIDER?.trim() || "openrouter"}/${model}`;
  try {
    judgeModel(id);
  } catch {
    return null;
  }
  return {
    policy: {
      mode: "enforce",
      fail: "open",
      timeout_s: 12,
      model: { id, effort: "medium", key_env: KEY_ENV },
      budget: { per_minute: Infinity, per_hour: Infinity },
      boundaries: [{ from: "*", to: "*" }],
    },
    options: {
      env: { [KEY_ENV]: key },
      // a bound fetch: the Workers runtime refuses one called as another object's method
      client: (m, k) => new HttpJudgeClient({ model: m.id, effort: m.effort, key: k, fetch: (input, init) => fetch(input, init) }),
      limits: { heldPerSender: Infinity },
    },
  };
}

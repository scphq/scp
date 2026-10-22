import type { GrantSummary, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export async function userGrants(oauth: OAuthHelpers, userId: string): Promise<GrantSummary[]> {
  const grants: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, cursor ? { cursor } : {});
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return grants;
}

import { AuthorizationError, CimdFetchError, OAuthProvider, type OAuthProviderOptions, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import type { HubGrant } from "@scp-dev/hub";
import { authenticate } from "./credentials";
import type { Env } from "./env";
import { html } from "./html";
import { GRANT_HEADER, ORG_HEADER } from "./hub/grant";
import { JUDGE_HEADER } from "./hub/judge";
import { closeGrants, hubStub, judgeEnabled } from "./hub/routes";
import { userGrants } from "./grants";
import { listOrgs, membership } from "./orgs";
import { connectorLabel, HttpError, json } from "./util";
import { back, type Ctx, field, page, readForm, toSignIn } from "./web";

interface Props {
  orgId: string;
  org: string;
  userId: string;
  label: string;
  credentialId?: string;
  labels?: Record<string, string>;
  expiresAt?: number | null;
}

async function mcp(req: Request, env: Env, ctx: OAuthResourceContext<Props>): Promise<Response> {
  const p = ctx.props;
  if (!p.credentialId && !ctx.auth.scope.includes("scp.relay")) return json({ error: "insufficient_scope" }, 403);
  const member = await membership(env.DB, p.org, p.userId);
  if (!member || member.org.id !== p.orgId) return json({ error: "membership_ended" }, 401);
  const grant: HubGrant = {
    tokenId: p.credentialId ?? `oauth_${ctx.auth.token.split(":")[1]}`,
    userId: p.orgId,
    actorId: p.userId,
    scoped: true,
    role: "member",
    labels: { ...p.labels, client: p.label },
    expiresAt: ctx.auth.expiresAt ? ctx.auth.expiresAt * 1000 : (p.expiresAt ?? Date.now() + 3600_000),
  };
  const headers = new Headers();
  for (const [name, value] of req.headers) if (!name.startsWith("x-scp-") && name !== "authorization" && name !== "cookie") headers.set(name, value);
  headers.set(GRANT_HEADER, JSON.stringify(grant));
  headers.set(ORG_HEADER, p.org);
  headers.set(JUDGE_HEADER, (await judgeEnabled(env.DB, p.orgId)) ? "1" : "0");
  headers.set("x-scp-hub-client", p.label);
  return hubStub(env, p.orgId).fetch("https://hub.internal/mcp", {
    method: req.method,
    headers,
    ...(req.method !== "GET" && req.method !== "HEAD" ? { body: req.body } : {}),
  });
}

const providers = new Map<string, OAuthProvider<Env>>();
export function oauthProvider(env: Env, defaultHandler: ExportedHandler<Env>): OAuthProvider<Env> {
  const origin = new URL(env.RELAY_ORIGIN).origin;
  let provider = providers.get(origin);
  if (!provider) {
    const options: OAuthProviderOptions<Env> = {
      apiRoute: "/mcp",
      apiHandler: { fetch: (req, env, ctx) => mcp(req, env, ctx as OAuthResourceContext<Props>) },
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: ["scp.relay"],
      requiredScopes: ["scp.relay"],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3600,
      onError: () => undefined,
      clientRegistrationCallback: ({ clientMetadata }) => {
        const methods = clientMetadata.token_endpoint_auth_methods_supported;
        if (clientMetadata.token_endpoint_auth_method !== "none" || (methods && (!Array.isArray(methods) || methods.some((m) => m !== "none"))))
          return { code: "invalid_client_metadata", description: "Only public clients are supported.", status: 400 };
      },
      resolveExternalToken: async ({ request, env }) => {
        const result = await authenticate(env.DB, request.headers.get("authorization"));
        if (!result.ok) return null;
        const g = result.grant;
        return {
          audience: `${origin}/mcp`,
          props: {
            orgId: g.orgId,
            org: g.org,
            userId: g.userId,
            label: "mcp-remote",
            credentialId: g.credentialId,
            labels: g.endpointLabels,
            expiresAt: g.expiresAt,
          } satisfies Props,
        };
      },
    };
    // The library requires an own undefined value for grants without expiry.
    Object.assign(options, { refreshTokenTTL: undefined });
    provider = new OAuthProvider<Env>(options);
    providers.set(origin, provider);
  }
  return provider;
}

export async function authorize(ctx: Ctx): Promise<Response> {
  const oauth = ctx.env.OAUTH_PROVIDER;
  try {
    if (ctx.req.method !== "GET" && ctx.req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use GET or POST.");
    if (ctx.req.method === "POST") {
      if (!ctx.user) throw new HttpError(401, "signed_out", "Sign in first.");
      const form = await readForm(ctx);
      const handle = field(form, "handle");
      if (field(form, "decision") === "deny") {
        const denied = await oauth.denyConsent(ctx.req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (field(form, "decision") !== "allow") throw new HttpError(400, "invalid_request", "Choose Allow or Deny.");
      const org = await membership(ctx.env.DB, field(form, "org"), ctx.user.id);
      if (!org) throw new HttpError(403, "forbidden", "Choose an organization you belong to.");
      const approved = await oauth.approveConsent(ctx.req, handle, { scope: ["scp.relay"] });
      const r = approved.request;
      const query = new URLSearchParams(
        Object.entries({
          client_id: r.clientId,
          redirect_uri: r.redirectUri,
          response_type: r.responseType,
          scope: r.scope.join(" "),
          state: r.state,
          resource: r.resource,
          code_challenge: r.codeChallenge,
          code_challenge_method: r.codeChallengeMethod,
        }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""),
      );
      const request = await oauth.parseAuthRequest(new Request(`${ctx.env.RELAY_ORIGIN}/authorize?${query}`));
      const client = await oauth.lookupClient(request.clientId);
      if (client?.tokenEndpointAuthMethod !== "none") throw new HttpError(400, "invalid_client", "Only public clients are supported.");
      const redirectHost = new URL(request.redirectUri).hostname;
      const label = connectorLabel(redirectHost);
      const replaced = (await userGrants(oauth, ctx.user.id)).filter(
        (g) => g.clientId === request.clientId && g.metadata?.orgId === org.org.id && g.metadata?.redirectUri === request.redirectUri,
      );
      const { redirectTo } = await oauth.completeAuthorization({
        request,
        revokeExistingGrants: false,
        userId: ctx.user.id,
        scope: ["scp.relay"],
        metadata: {
          orgId: org.org.id,
          org: org.org.handle,
          label,
          redirectHost,
          redirectUri: request.redirectUri,
          clientName: client.clientName ?? "Connector",
        },
        props: { orgId: org.org.id, org: org.org.handle, userId: ctx.user.id, label } satisfies Props,
      });
      for (const g of replaced) {
        await oauth.revokeGrant(g.id, g.userId);
        await closeGrants(ctx.env, org.org.id, { tokenId: `oauth_${g.id}` });
      }
      approved.headers.set("location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    const request = await oauth.parseAuthRequest(ctx.req);
    const client = await oauth.lookupClient(request.clientId);
    if (client?.tokenEndpointAuthMethod !== "none") throw new HttpError(400, "invalid_client", "Only public clients are supported.");
    if (!ctx.user) return toSignIn(ctx);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    const orgs = await listOrgs(ctx.env.DB, ctx.user.id);
    const response = page(
      ctx,
      { title: "Connect to the relay", narrow: true },
      html`<h1>Connect ${details.clientName}</h1>
      <p class="lead">Access will be sent to <strong>${details.redirectHost}</strong>.</p>
      ${details.clientDomain ? html`<p>Published at <strong>${details.clientDomain}</strong>.</p>` : html`<p>This client registered its own name.</p>`}
      ${details.redirectIsLoopback ? html`<p class="notice">This sends access to an app on your computer. Continue only if you started this connection.</p>` : ""}
      <p>Allow this connector to exchange messages and manage agents in the selected organization.</p>
      <form class="form" method="post" action="/authorize"><input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="handle" value="${consent.handle}">
      <label class="field">Organization<select name="org" required>${orgs.map((o) => html`<option value="${o.handle}">${o.name}</option>`)}</select></label>
      <div class="acts"><button class="btn btn-primary" name="decision" value="allow">Allow</button><button class="btn" name="decision" value="deny">Deny</button></div></form>`,
    );
    for (const cookie of consent.headers.getAll("set-cookie")) response.headers.append("set-cookie", cookie);
    response.headers.set("x-frame-options", "DENY");
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      if (error instanceof AuthorizationError && error.redirectTo) return back(ctx, error.redirectTo);
      return json({ error: "invalid_request", message: "The authorization request could not be verified." }, 400);
    }
    throw error;
  }
}

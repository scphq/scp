import type { HubGraph } from "@scp-dev/hub";
import type { DeviceCode, DeviceStatus, Overview, Session, Snapshot } from "./api";
import { dashboardPage, type DashboardTab, destination, devicePage, errorPage, notFoundPage, route, signInPage } from "./pages";

declare global {
  interface Window {
    scpRegion?: () => Promise<Element | null>;
  }
}

let session: Session = { signedIn: false, csrf: "" };
let generation = 0;
let submitting = false;

class SignedOut extends Error {}

async function request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/v1/dashboard/${path}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
    ...(body ? { body: JSON.stringify({ ...body, csrf: session.csrf }) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    const detail = (data && typeof data === "object" ? data : {}) as { error?: unknown; message?: unknown };
    if (response.status === 401 && detail.error === "signed_out") throw new SignedOut();
    throw new Error(
      typeof detail.message === "string"
        ? detail.message
        : detail.error === "invalid_token"
          ? "The token is not valid."
          : "The relay could not complete the request.",
    );
  }
  return data as T;
}

function swap(markup: string): void {
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  const scripts = [...parsed.querySelectorAll<HTMLScriptElement>("script[src]")];
  document.head.replaceWith(parsed.head);
  document.body.replaceWith(parsed.body);
  for (const old of scripts) {
    const script = document.createElement("script");
    for (const attr of old.attributes) script.setAttribute(attr.name, attr.value);
    script.async = false;
    old.replaceWith(script);
  }
}

function signedOut(): void {
  location.replace(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`);
}

async function optional<T>(path: string): Promise<T | null> {
  try {
    return await request<T>(path);
  } catch (error) {
    if (error instanceof SignedOut) throw error;
    return null;
  }
}

async function snapshot(tab: DashboardTab): Promise<Snapshot> {
  const live = ["overview", "activity", "sessions", "graph", "graph/full"].includes(tab);
  const graph = ["overview", "graph", "graph/full"].includes(tab);
  const [overview, g] = await Promise.all([live ? optional<Overview>("overview") : null, graph ? optional<HubGraph>("graph") : null]);
  return { overview, graph: g };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : "The relay could not complete the request.");
const afterSignIn = (): void => location.replace(destination(new URLSearchParams(location.search).get("next")));

async function poll(code: DeviceCode, current: number): Promise<void> {
  const expires = Date.now() + code.expires_in * 1000;
  const interval = Math.max(1, code.interval) * 1000;
  while (current === generation) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    if (current !== generation) return;
    if (Date.now() >= expires) break;
    const result = await request<DeviceStatus>("device/poll", { device_code: code.device_code });
    if (current !== generation) return;
    if (result.status === "ok") {
      afterSignIn();
      return;
    }
    if (result.status !== "pending") {
      swap(signInPage(session, result.status === "denied" ? "Device sign-in was denied." : "The device code expired. Try again."));
      return;
    }
  }
  if (current === generation) swap(signInPage(session, "The device code expired. Try again."));
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const signOut = form.getAttribute("action") === "/sign-out";
  const signIn = form.hasAttribute("data-sign-in");
  const device = form.hasAttribute("data-device");
  if (!signOut && !signIn && !device) return;
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  const current = ++generation;
  for (const button of form.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
  void (async () => {
    try {
      if (signOut) {
        await request("sign-out", {});
        location.replace("/sign-in");
      } else if (signIn) {
        const token = new FormData(form).get("token");
        await request("sign-in", { token: typeof token === "string" ? token : "" });
        afterSignIn();
      } else {
        const code = await request<DeviceCode>("device", {});
        swap(signInPage(session, "", code));
        void poll(code, current).catch((error: unknown) => {
          if (current === generation) swap(signInPage(session, message(error)));
        });
      }
    } catch (error) {
      if (error instanceof SignedOut) signedOut();
      else swap(session.signedIn ? errorPage(session, message(error)) : signInPage(session, message(error)));
    } finally {
      submitting = false;
    }
  })();
});

async function start(): Promise<void> {
  session = await request<Session>("session");
  if (!session.signedIn) {
    swap(signInPage(session));
    return;
  }
  const member = session;
  const next = route(location.pathname, member);
  if ("redirect" in next) {
    location.replace(next.redirect);
    return;
  }
  if ("page" in next) {
    swap(next.page === "device" ? devicePage(member, new URLSearchParams(location.search).get("user_code") ?? undefined) : notFoundPage(member));
    return;
  }
  const render = async (): Promise<string> => dashboardPage(member, next.tab, await snapshot(next.tab), Date.now());
  window.scpRegion = async () => {
    try {
      return new DOMParser().parseFromString(await render(), "text/html").querySelector("[data-live]");
    } catch (error) {
      if (error instanceof SignedOut) signedOut();
      return null;
    }
  };
  swap(await render());
}

void start().catch((error: unknown) => {
  if (error instanceof SignedOut) signedOut();
  else swap(errorPage(session, message(error)));
});

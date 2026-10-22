import { createConnection, type Socket } from "node:net";
import { waitFor } from "../targets";
import { hasMethod, methodRef, validate } from "./schema";

export type BrokerFrame = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: { code: string; retry_after?: number; [key: string]: unknown } };
};

/** a JSON-RPC error answer, carrying the SCP code from `error.data.code` */
export class WireError extends Error {
  constructor(
    readonly method: string,
    readonly frame: BrokerFrame,
  ) {
    super(`${method}: ${JSON.stringify(frame.error)}`);
  }
  get code() {
    return this.frame.error?.data?.code;
  }
  get rpcCode() {
    return this.frame.error?.code;
  }
  get data() {
    return this.frame.error?.data;
  }
}

/** frames that did not conform, shared by every wire of a test so the fixture can fail it */
export const violations: string[] = [];

const frameRef = (name: string) => `frames.schema.json#/$defs/${name}`;
function conform(ref: string, value: unknown, what: string) {
  const problems = validate(ref, value);
  if (problems.length) violations.push(`${what} against ${ref}: ${problems.slice(0, 5).join("; ")}\n  ${JSON.stringify(value).slice(0, 600)}`);
}

/** one NDJSON connection to a broker socket; every frame either way is checked against the wire schemas */
export class BrokerWire {
  readonly frames: BrokerFrame[] = [];
  readonly lines: string[] = [];
  private nextId = 0;
  private pending = "";
  private methods = new Map<string | number, string>();
  closed = false;
  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.pending += chunk;
      for (;;) {
        const end = this.pending.indexOf("\n");
        if (end < 0) break;
        const line = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + 1);
        if (!line.trim()) continue;
        this.lines.push(line);
        this.receive(line);
      }
    });
    socket.on("close", () => {
      this.closed = true;
    });
    socket.on("error", () => {
      this.closed = true;
    });
  }
  static async connect(path: string) {
    const socket = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new BrokerWire(socket);
  }
  private receive(line: string) {
    let frame: BrokerFrame;
    try {
      frame = JSON.parse(line) as BrokerFrame;
    } catch {
      violations.push(`unparseable line from the broker: ${line.slice(0, 200)}`);
      return;
    }
    this.frames.push(frame);
    if (frame.method !== undefined && frame.id === undefined) return conform(frameRef("Notification"), frame, "notification");
    if (frame.error) return conform(frameRef("ErrorResponse"), frame, "error response");
    conform(frameRef("SuccessResponse"), frame, "response");
    const method = frame.id === undefined || frame.id === null ? undefined : this.methods.get(frame.id);
    if (method && hasMethod(method)) conform(methodRef(method, "Result"), frame.result, `${method} result`);
  }
  /** writes one raw line, unchecked: for malformed input on purpose */
  raw(text: string) {
    this.socket.write(text);
  }
  /** sends a request and resolves with its response frame; `unchecked` skips the params schema for invalid input on purpose */
  async call(method: string, params: Record<string, unknown> = {}, options: { unchecked?: boolean; timeoutMs?: number } = {}) {
    const id = ++this.nextId;
    const request = { jsonrpc: "2.0", id, method, params };
    if (!options.unchecked) {
      conform(frameRef("Request"), request, "request");
      if (!hasMethod(method)) violations.push(`no schema for method ${method}`);
      else conform(methodRef(method, "Params"), params, `${method} params`);
    }
    this.methods.set(id, method);
    this.socket.write(`${JSON.stringify(request)}\n`);
    return await waitFor(
      () => {
        const found = this.frames.find((frame) => frame.id === id && frame.method === undefined);
        if (!found && this.closed) throw new Error(`${method}: connection closed before a response`);
        return found;
      },
      `${method} response`,
      options.timeoutMs ?? 15000,
    );
  }
  /** the result, or a WireError carrying the SCP code */
  async request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: { unchecked?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const frame = await this.call(method, params, options);
    if (frame.error) throw new WireError(method, frame);
    return frame.result as T;
  }
  /** a client notification: no id, no answer */
  notify(method: string, params: Record<string, unknown> = {}) {
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  async hello<T = Hello>(params: Record<string, unknown> = {}) {
    return this.request<T>("hello", { protocol: "scp/1", ...params });
  }
  fleet(type?: string) {
    return this.frames
      .filter((frame) => frame.method === "fleet" && frame.id === undefined && (!type || frame.params?.type === type))
      .map((frame) => frame.params as Record<string, unknown>);
  }
  async close() {
    if (this.closed) return;
    this.socket.end();
    await waitFor(() => this.closed, "socket close", 3000).catch(() => this.socket.destroy());
  }
}

export type View = {
  id: string;
  address: string;
  handle: string;
  kind: string;
  harness: string | null;
  presence: string;
  parent: string | null;
  depth: number;
  status: { state: string; note: string | null } | null;
  title: string | null;
  [key: string]: unknown;
};
export type Hello = {
  endpoint: View | null;
  capabilities: string[];
  server_time: string;
  limits: Record<string, number | null>;
  preamble: string;
  broker: Record<string, unknown>;
  token?: string;
  subagent?: true;
  created?: true;
  grant_bound?: true;
};

/** the SCP error code a request was refused with, undefined when it succeeded */
export async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WireError) return error.code;
    throw error;
  }
  return undefined;
}

import { waitFor } from "./targets";

export type Frame = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data: { code: string; retry_after?: number } };
};
export class Wire {
  readonly frames: Frame[] = [];
  private id = 0;
  closeCode: number | undefined;
  framesAtClose: number | undefined;
  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => this.frames.push(JSON.parse(String(event.data)) as Frame));
    ws.addEventListener("close", (event) => {
      this.framesAtClose = this.frames.length;
      this.closeCode = event.code;
    });
  }
  static async connect(url: string, token: string) {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/v1/relay/ws`, { headers: { authorization: `Bearer ${token}` } });
    const wire = new Wire(ws);
    try {
      await waitFor(() => {
        if (wire.closeCode !== undefined) throw new Error(`socket closed before open: ${wire.closeCode}`);
        return ws.readyState === WebSocket.OPEN;
      }, "websocket open");
      return wire;
    } catch (error) {
      ws.close();
      throw error;
    }
  }
  async call(method: string, params: object = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return await waitFor(() => this.frames.find((frame) => frame.id === id), `${method} response`);
  }
  async result<T>(method: string, params: object = {}): Promise<T> {
    const frame = await this.call(method, params);
    if (frame.error) throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
    return frame.result as T;
  }
  async hello(params: object) {
    return this.result<Record<string, unknown>>("hello", { protocol: "scp/1", ...params });
  }
  notifications(method: string) {
    return this.frames.filter((frame) => frame.method === method).map((frame) => frame.params!);
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await waitFor(() => this.closeCode !== undefined, "websocket close");
  }
}
export const rpc = async (url: string, token: string, body: unknown) => {
  const response = await fetch(`${url}/v1/relay/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<Frame | Frame[]>;
};

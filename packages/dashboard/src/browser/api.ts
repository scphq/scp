import type { ActivityRow, EndpointView } from "@scp-dev/core";
import type { HubGraph, MachineRow } from "@scp-dev/hub";

export type Session = { signedIn: false; csrf: string } | MemberSession;

export interface MemberSession {
  signedIn: true;
  csrf: string;
  org: { handle: string; name: string };
  member: { id: string; name: string; role: "owner" | "admin" | "member" };
  members: { id: string; name: string }[];
  devices: number;
  tokens: number;
}

export interface Overview {
  machines: MachineRow[];
  endpoints: EndpointView[];
  activity: ActivityRow[];
}

export interface Snapshot {
  overview: Overview | null;
  graph: HubGraph | null;
}

export interface DeviceCode {
  user_code: string;
  device_code: string;
  interval: number;
  expires_in: number;
}

export type DeviceStatus = { status: "pending" | "denied" | "expired" | "ok" };

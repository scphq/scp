export interface Address {
  readonly owner: string;
  readonly name: string;
}

export interface Envelope<T = unknown> {
  readonly id: string;
  readonly from: Address;
  readonly to: Address;
  readonly sentAt: string;
  readonly body: T;
}

export function formatAddress(address: Address): string {
  return `${address.owner}/${address.name}`;
}

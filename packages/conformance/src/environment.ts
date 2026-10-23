// Capture before the CLI test preload clears SCP variables.
export const relayBinary = process.env.SCP_RELAY_BIN;
export const postgresServer = process.env.SCP_CONFORMANCE_PG;
export const slowConformance = process.env.SCP_CONFORMANCE_SLOW === "1";
export const containerImage = process.env.SCP_CONFORMANCE_IMAGE;
export const selectedTargets = process.env.SCP_CONFORMANCE_TARGETS?.split(",").map((name) => name.trim());
export const brokerBinary = process.env.SCP_BROKER_BIN;
export const brokerNode = process.env.SCP_BROKER_NODE;
export const selectedBrokerTargets = process.env.SCP_BROKER_TARGETS?.split(",").map((name) => name.trim());
export const brokerReferenceWakers = process.env.SCP_BROKER_WAKERS === "1";

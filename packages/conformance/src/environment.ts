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
export const compatConformance = process.env.SCP_CONFORMANCE_COMPAT === "1";
export const compatDirectory = process.env.SCP_COMPAT_DIR;
/** `rust` runs every machine fixture's broker on SCP_BROKER_BIN, `mixed` every other one, so native and ts brokers bridge together */
export const machineBrokers = process.env.SCP_MACHINE_BROKERS;

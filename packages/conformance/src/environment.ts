// Capture before the CLI test preload clears SCP variables.
export const relayBinary = process.env.SCP_RELAY_BIN;
export const postgresServer = process.env.SCP_CONFORMANCE_PG;
export const slowConformance = process.env.SCP_CONFORMANCE_SLOW === "1";

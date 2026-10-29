import { strict as assert } from "assert";

export const checkEnv = (envName: string, defaultValue?: string) => {
  const env = process.env[envName] ?? defaultValue;
  if (env) {
    return env;
  }
  assert.notStrictEqual(env, undefined, `${envName} is not specified`);
  return env as string;
};

export const config = {
  rpcEndpoint: checkEnv("RPC_ENDPOINT"),
  factoryProgram: checkEnv("FACTORY_PROGRAM"),
  // Curve Launch program; empty disables launchpad indexing.
  launchpadProgram: (process.env.LAUNCHPAD_PROGRAM ?? "").toLowerCase(),
  rateLimit: Number.parseInt(checkEnv("RATE_LIMIT", "100")),
  minBlockNum: Number.parseInt(checkEnv("MIN_BLOCK_NUMBER", "0")),
  // Set DNS_API_URL=off to skip DNS resolution (local dev node).
  dnsApiUrl:
    process.env.DNS_API_URL || "https://stg-dns-explorer.gear.foundation",
  dnsProgramName: process.env.DNS_PROGRAM_NAME || "tokenator.club",
  gateway: process.env.SQUID_GATEWAY,
};

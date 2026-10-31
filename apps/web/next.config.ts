import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg", "@privy-io/node"],
  experimental: { cpus: 2 },
  // Dev logs print server action arguments, and every API call goes through serverCall:
  // that would log phone numbers, OTP codes and bank details.
  logging: { serverFunctions: false },
};
export default config;

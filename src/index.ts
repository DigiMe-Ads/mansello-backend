import dns from "dns";
import { createApp } from "@/app";
import { env } from "@/config/env";
import { startJobs } from "@/jobs";

// Node 18+ changed dns.lookup()'s default order to whatever the OS returns,
// instead of always preferring IPv4 (nodejs/node#42381). On a network where
// IPv6 is advertised but not actually routed (common on Windows/residential
// setups), that surfaces as ECONNREFUSED to any hostname with an AAAA
// record — e.g. Gmail SMTP — even though the IPv4 address works fine. This
// restores the old, safer default for every outbound connection in the app.
dns.setDefaultResultOrder("ipv4first");

const app = createApp();

app.listen(env.port, () => {
  console.log(`mansello-backend listening on :${env.port} (${env.nodeEnv})`);
  startJobs();
});

import { createApp } from "@/app";
import { env } from "@/config/env";
import { startJobs } from "@/jobs";

const app = createApp();

app.listen(env.port, () => {
  console.log(`mansello-backend listening on :${env.port} (${env.nodeEnv})`);
  startJobs();
});

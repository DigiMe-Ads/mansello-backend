import { deleteStaleClickEvents } from "@/modules/analytics/service";

export async function runClickEventRetentionJob() {
  const count = await deleteStaleClickEvents();
  if (count > 0) console.log(`Deleted ${count} click_events row(s) older than the retention window`);
}

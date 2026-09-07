import { expireStalePendingOrders } from "@/modules/marketplace/orders/service";

export async function runOrderExpiryJob() {
  const count = await expireStalePendingOrders();
  if (count > 0) console.log(`Cancelled ${count} stale pending marketplace order(s)`);
}

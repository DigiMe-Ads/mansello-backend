import { listLowStock } from "@/modules/marketplace/catalog/service";
import { sendLowStockAlert } from "@/modules/notifications/email";

interface LowStockRow {
  quantityOnHand: number;
  product: { name: string };
}

export async function runLowStockAlertJob(adminEmail: string) {
  const rows = (await listLowStock()) as LowStockRow[];
  for (const row of rows) {
    await sendLowStockAlert(adminEmail, row.product.name, row.quantityOnHand);
  }
}

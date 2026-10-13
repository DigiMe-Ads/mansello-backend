import { listLowStock } from "@/modules/marketplace/catalog/service";
import { sendLowStockAlert } from "@/modules/notifications/email";

export async function runLowStockAlertJob(adminEmail: string) {
  const rows = await listLowStock();
  for (const row of rows) {
    // "Moisture Surge (80ml)" for a variation, same as the admin banner.
    const name = row.variant ? `${row.product.name} (${row.variant.name})` : row.product.name;
    await sendLowStockAlert(adminEmail, name, row.quantityOnHand);
  }
}

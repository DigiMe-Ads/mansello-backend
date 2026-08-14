# Mansello Backend → Frontend: Delete Categories & Products

Companion doc to `API_DOCUMENTATION.md` (§6, Marketplace catalog). Covers one new capability, already live: the admin marketplace panel can now delete leftover/test categories and products, not just create and edit them — and move a product between categories, which it couldn't do before either.

## What's new on the backend (already deployed, nothing to wait on)

Three changes, all under `/api/marketplace/catalog`:

| Method | Path | Auth | Behavior |
|---|---|---|---|
| DELETE | `/api/marketplace/catalog/products/:id` | super_admin, marketplace_manager | Deletes a product. `204` on success. `404` if it doesn't exist. `409` if the product has ever been ordered (real order history references it) — deleting it would break those historical order records, so it's blocked instead. |
| DELETE | `/api/marketplace/catalog/categories/:id` | super_admin, marketplace_manager | Deletes a category. `204` on success. `404` if it doesn't exist. `409` if it still has any products assigned to it — no cascade, no auto-delete of its products. Move or delete them first. |
| PATCH | `/api/marketplace/catalog/products/:id` | super_admin, marketplace_manager | **New field accepted**: `categoryId`, alongside the existing `name`/`description`/`priceUsd`/`images`/`active`. Lets a product move to a different category — the missing piece that makes emptying out a category before deleting it actually possible. |

Same `Authorization: Bearer <accessToken>` pattern as every other admin endpoint — nothing new to wire up on the auth side.

## Why the deletes are guarded instead of unconditional

- **Products**: a product that's actually been ordered keeps a row in `OrderItem`, which snapshots its name/price at the time of purchase — that's how a historical order still displays correctly even after a product's price changes or it goes out of stock. Deleting the product out from under that would break order history, so the backend refuses (`409`) rather than cascading or silently detaching it.
  - **Deactivating is the right move for that case instead** — `PATCH { "active": false }` already exists and already hides a product from the public storefront (`GET /api/marketplace/catalog/products` only returns `active: true` products) without touching any order records. For a product that's been ordered before but shouldn't be sold anymore, deactivate rather than trying to delete.
- **Categories**: a product's `categoryId` is required (never null), so a category can't be deleted while anything still points to it — that would leave orphaned products. Move the products out (new `PATCH { categoryId }`) or delete them first, then the now-empty category deletes cleanly.

## What's needed on the frontend

1. **Products list/table** in the admin marketplace panel: add a delete action per row.
   - Confirm before sending — this is destructive and there's no "undo"/restore endpoint.
   - On `409`, show the response body's `error` message directly — it already reads naturally as user-facing text (*"This product has order history and can't be deleted — deactivate it instead (PATCH active: false)"*), no translation needed. Worth adding a "Deactivate instead?" quick action right in that error state, wired to the existing `active` toggle, since that's almost always the actual next step.
2. **Categories list**: same pattern — delete action per row, confirm first, surface the `409` message directly (*"This category still has N product(s) — delete or move them first"*).
   - Since moving products between categories wasn't possible via the API until now, there's probably no "change category" control on the product edit form yet — worth adding one (a `categoryId` select), since it's now the actual supported way to empty out a category without deleting its products.
3. Both `DELETE` endpoints return no body on success (`204`) — just drop the row from local state / refetch the list, same as any other successful delete elsewhere in the panel.

That's the whole change — no new pages, no new routes, just a delete action on two existing admin list views, a category-select on the product edit form, and handling for the one `409` case each delete can return.

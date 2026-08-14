import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as service from "./service";
import { uploadImage } from "@/modules/uploads/imageUpload";

export async function listCategories(_req: Request, res: Response) {
  res.json(await service.listCategories());
}

export async function createCategory(req: Request, res: Response) {
  res.status(201).json(await service.createCategory(req.body));
}

export async function deleteCategory(req: Request, res: Response) {
  await service.deleteCategory(req.params.id);
  res.status(204).send();
}

export async function listProducts(req: Request, res: Response) {
  res.json(await service.listProducts(req.query.category as string | undefined));
}

export async function getProduct(req: Request, res: Response) {
  const product = await service.getProduct(req.params.id);
  if (!product) throw ApiError.notFound("Product not found");
  res.json(product);
}

// Kept as a backward-compatible alias — /api/uploads/images is now the
// canonical endpoint (shared by offers/blog too), but this one already had a
// working frontend integration, so it stays wired to the same underlying
// uploadImage() rather than being removed.
export async function uploadProductImages(req: Request, res: Response) {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files?.length) throw ApiError.badRequest("No files uploaded (field name must be \"images\")");
  const urls = await Promise.all(files.map((f) => uploadImage(f, "products")));
  res.status(201).json({ urls });
}

export async function createProduct(req: Request, res: Response) {
  res.status(201).json(await service.createProduct(req.body));
}

export async function updateProduct(req: Request, res: Response) {
  res.json(await service.updateProduct(req.params.id, req.body));
}

export async function deleteProduct(req: Request, res: Response) {
  await service.deleteProduct(req.params.id);
  res.status(204).send();
}

export async function adjustStock(req: Request, res: Response) {
  res.json(await service.adjustStock(req.params.id, req.body.delta));
}

export async function listLowStock(_req: Request, res: Response) {
  res.json(await service.listLowStock());
}

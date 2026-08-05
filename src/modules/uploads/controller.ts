import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import { uploadImage } from "./imageUpload";

export async function uploadImages(req: Request, res: Response) {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files?.length) throw ApiError.badRequest("No files uploaded (field name must be \"images\")");
  const urls = await Promise.all(files.map((f) => uploadImage(f)));
  res.status(201).json({ urls });
}

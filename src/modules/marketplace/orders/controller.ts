import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as service from "./service";

export async function createOrder(req: Request, res: Response) {
  res.status(201).json(await service.createOrder(req.body));
}

export async function listOrders(req: Request, res: Response) {
  res.json(await service.listOrders(req.query.status as string | undefined));
}

export async function getOrder(req: Request, res: Response) {
  const order = await service.getOrder(req.params.id);
  if (!order) throw ApiError.notFound("Order not found");
  res.json(order);
}

export async function updateOrderStatus(req: Request, res: Response) {
  res.json(await service.updateOrderStatus(req.params.id, req.body.status));
}

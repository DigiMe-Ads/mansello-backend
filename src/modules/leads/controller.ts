import { Request, Response } from "express";
import * as service from "./service";

export async function createContactMessage(req: Request, res: Response) {
  res.status(201).json(await service.createContactMessage(req.body));
}

export async function listContactMessages(req: Request, res: Response) {
  res.json(await service.listContactMessages(req.query.status as string | undefined));
}

export async function updateContactMessageStatus(req: Request, res: Response) {
  res.json(await service.updateContactMessageStatus(req.params.id, req.body.status));
}

export async function createTransportRequest(req: Request, res: Response) {
  res.status(201).json(
    await service.createTransportRequest({ ...req.body, date: new Date(req.body.date) })
  );
}

export async function listTransportRequests(req: Request, res: Response) {
  res.json(await service.listTransportRequests(req.query.status as string | undefined));
}

export async function updateTransportRequestStatus(req: Request, res: Response) {
  res.json(await service.updateTransportRequestStatus(req.params.id, req.body.status));
}

export async function subscribeToNewsletter(req: Request, res: Response) {
  res.status(201).json(await service.subscribeToNewsletter(req.body.email, req.body.site));
}

export async function listNewsletterSubscribers(req: Request, res: Response) {
  res.json(await service.listNewsletterSubscribers(req.query.site as string | undefined));
}

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "@/config/env";
import { errorHandler } from "@/middleware/errorHandler";

import propertiesRoutes from "@/modules/properties/routes";
import availabilityRoutes from "@/modules/availability/routes";
import icalExportRoutes from "@/modules/availability/icalExport";
import bookingsRoutes from "@/modules/bookings/routes";
import { italyWebhookRouter, sriLankaWebhookRouter } from "@/modules/payments/webhooks";
import catalogRoutes from "@/modules/marketplace/catalog/routes";
import ordersRoutes from "@/modules/marketplace/orders/routes";
import leadsRoutes from "@/modules/leads/routes";
import adminAuthRoutes from "@/modules/admin/routes";
import offersRoutes from "@/modules/offers/routes";
import blogRoutes from "@/modules/blog/routes";
import uploadsRoutes from "@/modules/uploads/routes";
import {
  templateRoutes as guestInfoTemplateRoutes,
  bookingRoutes as bookingInfoRequestRoutes,
  publicRoutes as bookingInfoPublicRoutes,
} from "@/modules/guestInfo/routes";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin }));
  app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));

  // Stripe webhooks need the raw body for signature verification, so they're
  // mounted BEFORE express.json().
  app.use("/webhooks/stripe/italy", italyWebhookRouter);
  app.use("/webhooks/stripe/sri-lanka", sriLankaWebhookRouter);

  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/ical", icalExportRoutes);

  app.use("/api/properties", propertiesRoutes);
  app.use("/api/availability", availabilityRoutes);
  app.use("/api/bookings", bookingsRoutes);
  // Adds /:id/info-requests on top of the routes above — a separate router
  // (see modules/guestInfo/routes.ts) so that module stays self-contained.
  app.use("/api/bookings", bookingInfoRequestRoutes);
  app.use("/api/marketplace/catalog", catalogRoutes);
  app.use("/api/marketplace/orders", ordersRoutes);
  app.use("/api/leads", leadsRoutes);
  app.use("/api/admin", adminAuthRoutes);
  app.use("/api/admin/guest-info-template", guestInfoTemplateRoutes);
  app.use("/api/offers", offersRoutes);
  app.use("/api/blog", blogRoutes);
  app.use("/api/uploads", uploadsRoutes);
  app.use("/api/booking-info-requests", bookingInfoPublicRoutes);

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(errorHandler);

  return app;
}

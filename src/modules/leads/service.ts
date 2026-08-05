import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";

export function createContactMessage(input: {
  site: "italy" | "sri_lanka";
  name: string;
  email: string;
  subject: "room_booking" | "airport_transfer" | "marketplace" | "other";
  message: string;
}) {
  return prisma.contactMessage.create({ data: input });
}

export function listContactMessages(status?: string) {
  return prisma.contactMessage.findMany({
    where: status ? { status: status as never } : {},
    orderBy: { createdAt: "desc" },
  });
}

export function updateContactMessageStatus(id: string, status: "new" | "read" | "responded") {
  return prisma.contactMessage.update({ where: { id }, data: { status } });
}

export function createTransportRequest(input: {
  propertyId?: string;
  bookingId?: string;
  type: "fixed_price" | "custom_quote";
  date: Date;
  flightNumber?: string;
  passengers: number;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes?: string;
}) {
  return prisma.transportRequest.create({ data: input });
}

export function listTransportRequests(status?: string) {
  return prisma.transportRequest.findMany({
    where: status ? { status: status as never } : {},
    orderBy: { createdAt: "desc" },
  });
}

export function updateTransportRequestStatus(id: string, status: "new" | "read" | "responded") {
  return prisma.transportRequest.update({ where: { id }, data: { status } });
}

export async function subscribeToNewsletter(email: string, site: "italy" | "sri_lanka") {
  const existing = await prisma.newsletterSubscriber.findUnique({
    where: { email_site: { email, site } },
  });
  if (existing) throw ApiError.conflict("This email is already subscribed for this site");
  return prisma.newsletterSubscriber.create({ data: { email, site } });
}

export function listNewsletterSubscribers(site?: string) {
  return prisma.newsletterSubscriber.findMany({
    where: site ? { site: site as never } : {},
    orderBy: { subscribedAt: "desc" },
  });
}

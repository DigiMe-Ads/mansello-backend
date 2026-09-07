import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";

export function listTestimonials(options: { site?: "italy" | "sri_lanka"; includeInactive: boolean }) {
  return prisma.testimonial.findMany({
    where: {
      ...(options.site ? { site: options.site } : {}),
      ...(options.includeInactive ? {} : { active: true }),
    },
    orderBy: { sortOrder: "asc" },
  });
}

export interface CreateTestimonialInput {
  site: "italy" | "sri_lanka";
  name: string;
  role: string;
  quote: string;
  rating: number;
  sortOrder?: number;
  active?: boolean;
}

export function createTestimonial(input: CreateTestimonialInput) {
  return prisma.testimonial.create({
    data: {
      site: input.site,
      name: input.name,
      role: input.role,
      quote: input.quote,
      rating: input.rating,
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
    },
  });
}

// `site` is deliberately not part of this update shape — moving a review to
// the other site's carousel isn't a real use case (see
// BACKEND_CHANGES_TESTIMONIALS.md); delete and recreate it there instead.
export function updateTestimonial(
  id: string,
  data: Partial<{
    name: string;
    role: string;
    quote: string;
    rating: number;
    sortOrder: number;
    active: boolean;
  }>
) {
  return prisma.testimonial.update({ where: { id }, data });
}

// Hard delete — no downstream records reference a Testimonial the way they
// do a Product/Room/Booking, so there's no "has history, deactivate
// instead" guard needed here; `active: false` via updateTestimonial already
// covers the "hide but keep" case.
export async function deleteTestimonial(id: string) {
  const testimonial = await prisma.testimonial.findUnique({ where: { id } });
  if (!testimonial) throw ApiError.notFound("Testimonial not found");
  await prisma.testimonial.delete({ where: { id } });
}

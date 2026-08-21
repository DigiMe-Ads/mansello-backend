import { z } from "zod";

export const createRoomSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    subtitle: z.string().optional(),
    capacity: z.coerce.number().int().min(1),
    pricePerNight: z.coerce.number().min(0),
    images: z.array(z.string()).optional(),
    sortOrder: z.coerce.number().int().optional(),
  }),
});

export const updateRoomSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    subtitle: z.string().nullable().optional(),
    capacity: z.coerce.number().int().min(1).optional(),
    pricePerNight: z.coerce.number().min(0).optional(),
    images: z.array(z.string()).optional(),
    sortOrder: z.coerce.number().int().optional(),
    active: z.boolean().optional(),
  }),
});

import { z } from "zod";

const siteEnum = z.enum(["italy", "sri_lanka"]);

export const createPostSchema = z.object({
  body: z.object({
    site: siteEnum,
    title: z.string().min(1),
    slug: z.string().min(1).optional(),
    excerpt: z.string().min(1),
    body: z.string().min(1),
    coverImageUrl: z.string().url().optional(),
    author: z.string().min(1),
    publishedAt: z.coerce.date().nullable().optional(),
  }),
});

export const updatePostSchema = z.object({
  body: z.object({
    title: z.string().min(1).optional(),
    excerpt: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    coverImageUrl: z.string().url().nullable().optional(),
    author: z.string().min(1).optional(),
    publishedAt: z.coerce.date().nullable().optional(),
  }),
});

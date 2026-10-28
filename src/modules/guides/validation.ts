import { z } from "zod";

// The guest guide's whole shape. Mirrors GuideContent in the frontend's
// src/lib/guide/types.ts — keep the two in step. Every image/link is a
// root-relative path or an https:// URL (same rule as SiteContent images):
// they end up in <img src> / <a href> and a QR code people scan, so no
// javascript:, data: or plain-http values.

const text = (max: number) => z.string().trim().max(max);

const url = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => v === "" || v.startsWith("/") || v.startsWith("https://"), {
    message: 'must be a root-relative path ("/...") or an https:// URL',
  });

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a hex colour like #053F34");

const heading = { eyebrow: text(60), title: text(120) };

export const guideContentSchema = z.object({
  theme: z.object({ primary: color, accent: color, panel: color, background: color }),
  footer: text(80),
  cover: z.object({
    brand: text(60),
    place: text(60),
    kicker: text(80),
    title: text(120),
    tagline: text(120),
    banner: text(200),
    image: url,
  }),
  welcome: z.object({ ...heading, image: url, headline: text(200), lines: z.array(text(300)).max(6) }),
  days: z
    .array(
      z.object({
        ...heading,
        stops: z
          .array(z.object({ title: text(100), time: text(40), description: text(600), image: url }))
          .max(10),
        note: text(300),
      })
    )
    .max(7),
  food: z.object({
    ...heading,
    image: url,
    items: z.array(text(120)).max(20),
    tipTitle: text(80),
    tipText: text(500),
  }),
  tips: z.object({
    ...heading,
    image: url,
    items: z.array(z.object({ title: text(60), text: text(400) })).max(12),
    note: text(300),
  }),
  extras: z.object({
    ...heading,
    image: url,
    items: z.array(text(300)).max(15),
    thanksTitle: text(120),
    thanksText: text(300),
  }),
  links: z.object({
    ...heading,
    items: z.array(z.object({ label: text(40), url })).max(8),
    name: text(80),
    address: text(200),
  }),
});

export type GuideContent = z.infer<typeof guideContentSchema>;

const siteParam = z.object({ site: z.enum(["italy", "sri-lanka", "sri_lanka"]) });

export const getGuideSchema = z.object({ params: siteParam });
export const putGuideSchema = z.object({ params: siteParam, body: z.object({ content: guideContentSchema }) });

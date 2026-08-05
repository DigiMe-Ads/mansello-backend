import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";
import { slugify } from "@/utils/slugify";

export function listPosts(options: { site?: "italy" | "sri_lanka"; includeDrafts: boolean }) {
  return prisma.blogPost.findMany({
    where: {
      ...(options.site ? { site: options.site } : {}),
      ...(options.includeDrafts ? {} : { publishedAt: { not: null } }),
    },
    orderBy: { createdAt: "desc" },
  });
}

// Drafts are never reachable here, even by someone who knows/guesses the
// exact slug — this is the only lookup path for the public single-post view.
export async function getPublishedPostBySlug(slug: string) {
  const post = await prisma.blogPost.findUnique({ where: { slug } });
  if (!post || !post.publishedAt) throw ApiError.notFound("Post not found");
  return post;
}

export interface CreatePostInput {
  site: "italy" | "sri_lanka";
  title: string;
  slug?: string;
  excerpt: string;
  body: string;
  coverImageUrl?: string;
  author: string;
  publishedAt?: Date | null;
}

export async function createPost(input: CreatePostInput) {
  const slug = input.slug?.trim() ? slugify(input.slug) : slugify(input.title);
  if (!slug) throw ApiError.badRequest("Could not derive a valid slug from title");

  const existing = await prisma.blogPost.findUnique({ where: { slug } });
  if (existing) throw ApiError.conflict(`A post with slug "${slug}" already exists`);

  return prisma.blogPost.create({
    data: {
      site: input.site,
      slug,
      title: input.title,
      excerpt: input.excerpt,
      body: input.body,
      coverImageUrl: input.coverImageUrl,
      author: input.author,
      publishedAt: input.publishedAt ?? null,
    },
  });
}

export function updatePost(
  id: string,
  data: Partial<{
    title: string;
    excerpt: string;
    body: string;
    coverImageUrl: string | null;
    author: string;
    publishedAt: Date | null;
  }>
) {
  return prisma.blogPost.update({ where: { id }, data });
}

export async function deletePost(id: string) {
  const post = await prisma.blogPost.findUnique({ where: { id } });
  if (!post) throw ApiError.notFound("Post not found");
  await prisma.blogPost.delete({ where: { id } });
}

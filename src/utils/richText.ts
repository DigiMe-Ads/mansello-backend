import sanitizeHtml from "sanitize-html";

// Product descriptions are a small HTML subset produced by the admin's
// WYSIWYG editor. Same whitelist as the frontend's src/lib/rich-text.ts —
// the frontend sanitizes too, but this API is public-facing and can't trust
// it. Every other tag is dropped but its text kept; script/style/etc. are
// dropped along with their contents; no attributes survive at all (style,
// class, href, on* …). Legacy plain-text descriptions pass through as text.
export function sanitizeDescription(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ["b", "strong", "i", "em", "u", "br", "p", "div", "ul", "ol", "li"],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
    nonTextTags: ["script", "style", "iframe", "object", "template", "textarea", "noscript"],
  }).trim();
}

// For anywhere a description goes that isn't rendered as HTML (emails, SEO
// meta, CSV, Stripe line items, …). Block-level tags become line breaks so
// list items don't run together.
export function descriptionToPlainText(html: string): string {
  const withBreaks = html.replace(/<\s*\/?\s*(br|p|div|ul|ol|li)\b[^>]*>/gi, "\n");
  const text = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// "Required" means visible text survives once the markup is gone — a
// description of just "<br>" or "<p>&nbsp;</p>" is empty.
export function hasVisibleText(html: string): boolean {
  return descriptionToPlainText(html).trim().length > 0;
}

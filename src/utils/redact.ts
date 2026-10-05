// Response shaping for public, unauthenticated lookups (booking/order
// confirmation pages) — enough for the page to address the customer,
// nothing a stranger holding the id could use.

// "chanka@gmail.com" -> "c•••@gmail.com"
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

// "+94 77 123 4521" -> "•••• 4521"
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "••••";
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

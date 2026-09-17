export interface AmcIdentityOptions {
  readonly userAgent: string;
}

export function validateIdentity(options: Partial<AmcIdentityOptions>): AmcIdentityOptions {
  if (!options.userAgent) {
    throw new Error("userAgent is required: unset User-Agent is prohibited by policy");
  }
  if (options.userAgent.trim() === "") {
    throw new Error("userAgent cannot be empty or whitespace");
  }
  if (/mozilla|applewebkit|chrome|safari|edge|trident|opera|msie/i.test(options.userAgent)) {
    throw new Error("userAgent must not spoof browser strings");
  }
  if (/[^\x20-\x7E]/.test(options.userAgent)) {
    throw new Error("userAgent contains control characters or non-printable ASCII");
  }
  const ua = options.userAgent;
  const hasContact = /(?:https?:\/\/[a-zA-Z0-9][^\s]*|mailto:[^\s@]+@[^\s@]+)/i.test(ua);
  const withoutContact = ua.replace(/(?:https?:\/\/[^\s)]+|mailto:[^\s)]+)/i, "").trim();
  const hasProductName = /[a-zA-Z0-9]/.test(withoutContact);
  if (!hasContact || !hasProductName) {
    throw new Error(
      "userAgent must contain a product name AND a contact URI or address (http/https/mailto)",
    );
  }
  return { userAgent: options.userAgent };
}

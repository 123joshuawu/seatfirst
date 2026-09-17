import { z } from "zod";

export interface NamespacedIdParts {
  readonly providerId: string;
  readonly kind: "showtime" | "theatre" | "movie";
  readonly raw: string;
}

export type ParseResult =
  | { ok: true; value: NamespacedIdParts }
  | { ok: false; error: { code: "INVALID_NAMESPACED_ID"; value: string } };

export function parseNamespacedId(value: string): ParseResult {
  const firstColon = value.indexOf(":");
  if (firstColon <= 0) return { ok: false, error: { code: "INVALID_NAMESPACED_ID", value } };

  const secondColon = value.indexOf(":", firstColon + 1);
  if (secondColon <= firstColon + 1)
    return { ok: false, error: { code: "INVALID_NAMESPACED_ID", value } };

  const kind = value.slice(firstColon + 1, secondColon);
  if (kind !== "showtime" && kind !== "theatre" && kind !== "movie") {
    return { ok: false, error: { code: "INVALID_NAMESPACED_ID", value } };
  }

  const raw = value.slice(secondColon + 1);
  if (raw.length === 0) return { ok: false, error: { code: "INVALID_NAMESPACED_ID", value } };

  return {
    ok: true,
    value: {
      providerId: value.slice(0, firstColon),
      kind,
      raw,
    },
  };
}

const namespacedIdOfKind = (expectedKind: "showtime" | "theatre" | "movie") =>
  z.string().refine(
    (val) => {
      const parsed = parseNamespacedId(val);
      return parsed.ok && parsed.value.kind === expectedKind;
    },
    { message: `Must be a valid namespaced identifier with kind '${expectedKind}'` },
  );

export const ShowtimeIdSchema = namespacedIdOfKind("showtime").brand<"ShowtimeId">();
export type ShowtimeId = z.infer<typeof ShowtimeIdSchema>;

export const TheatreIdSchema = namespacedIdOfKind("theatre").brand<"TheatreId">();
export type TheatreId = z.infer<typeof TheatreIdSchema>;

export const MovieIdSchema = namespacedIdOfKind("movie").brand<"MovieId">();
export type MovieId = z.infer<typeof MovieIdSchema>;

const NamespacedIdPartsSchema = z.strictObject({
  providerId: z.string().min(1),
  kind: z.enum(["showtime", "theatre", "movie"]),
  raw: z.string().min(1),
});

export function formatNamespacedId(parts: NamespacedIdParts): string {
  NamespacedIdPartsSchema.parse(parts);
  return `${parts.providerId}:${parts.kind}:${parts.raw}`;
}

import { z } from "zod";
import { extractFlightJSON } from "../flight.js";
import { ProviderError } from "../../errors.js";

const PublicMovieSummarySchema = z
  .object({
    name: z.string(),
    slug: z.string(),
    movieId: z.number(),
    detailsPath: z.string(),
    showtimesPath: z.string(),
    mpaaRating: z.string().nullable().optional(),
    runTimeMinutes: z.number().nullable().optional(),
    releaseDate: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    imageUrl: z.string().nullable().optional(),
    trailer: z.unknown().optional(),
    ratings: z.unknown().optional(),
    runTimeAttributeCodes: z.array(z.string()).optional(),
  })
  .passthrough();

export type PublicMovieSummary = z.infer<typeof PublicMovieSummarySchema>;

export function parseMovies(
  html: string,
  observationTime: Date,
  requestUrl: string,
): PublicMovieSummary[] {
  const chunks = extractFlightJSON(html);
  let movieArray: unknown[] | null = null;

  function search(node: unknown) {
    if (movieArray) return;
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      if (
        node.length > 0 &&
        typeof node[0] === "object" &&
        node[0] !== null &&
        "movieId" in node[0] &&
        typeof (node[0] as Record<string, unknown>).movieId === "number"
      ) {
        movieArray = node;
        return;
      }
      for (const item of node) search(item);
    } else {
      for (const key of Object.keys(node)) {
        search((node as Record<string, unknown>)[key]);
      }
    }
  }
  search(chunks);

  if (!movieArray) {
    throw new ProviderError(
      "UPSTREAM_CHANGED",
      "Movie validation failed: could not locate movie collection",
      { providerMeta: { requestUrl, observationTime } },
    );
  }

  const PublicMovieListSchema = z.array(PublicMovieSummarySchema);
  const parsed = PublicMovieListSchema.safeParse(movieArray);
  if (!parsed.success) {
    const err = parsed.error.issues[0];
    throw new ProviderError("UPSTREAM_CHANGED", `Movie validation failed: ${err?.message}`, {
      providerMeta: { requestUrl, observationTime },
    });
  }

  return parsed.data.map((raw) => ({
    ...raw,
    providerMeta: {
      requestUrl,
      observationTime: observationTime.toISOString(),
    },
  }));
}

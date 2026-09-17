import { trpc } from "@/lib/trpc";
import { useSeatfirstStore } from "@/store/seatfirstStore";

/**
 * Theatre-scoped movie browse.
 * - enabled only when bootstrapReady && theatreId != null
 * - honours from <= to and span <=30 days (validated server-side -> BAD_REQUEST)
 * - 404 maps to an error the caller renders as "Theatre not found" + retry
 * - posterPath may be null (placeholder)
 * - timezone is derived from response.timezone, not hard-coded
 */
export function useTheatreMovies(options: {
  theatreId: string | null | undefined;
  from: string;
  to: string;
}) {
  const { theatreId, from, to } = options;
  const bootstrapReady = useSeatfirstStore((s) => s.bootstrapReady);

  const enabled = bootstrapReady && theatreId != null && theatreId.length > 0;

  // Native tRPC react-query binding (UI11.4). The option widens the caller's branded
  // `TheatreId` to `string`; the value originates from a parsed search hit, so the
  // brand is recovered for the typed input. The query never fires while disabled,
  // mirroring the previous custom wrapper's `enabled` gate.
  return trpc.theatres.movies.useQuery(
    {
      // theatreId is guaranteed non-null when enabled is true
      theatreId: theatreId ?? "",
      from,
      to,
    },
    { enabled, staleTime: 30_000 },
  );
}

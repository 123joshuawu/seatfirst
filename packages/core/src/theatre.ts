import { z } from "zod";

import { TheatreIdSchema } from "./ids.js";
// `IanaTimezoneSchema` lives in `timezone.ts` (S20), not `result-contracts.ts`, so that
// module can import `TheatreSchema` from here without an ESM import cycle.
import { IanaTimezoneSchema } from "./timezone.js";

const finiteNumber = z.number().finite();
const nonemptyString = z.string().min(1);

export const GeoPointSchema = z.strictObject({
  lat: finiteNumber.min(-90).max(90),
  lng: finiteNumber.min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPointSchema>;

export const TheatreSchema = z.strictObject({
  id: TheatreIdSchema,
  providerId: nonemptyString,
  name: nonemptyString,
  location: GeoPointSchema,
  timezone: IanaTimezoneSchema,
  city: z.string().nullable(),
  address: z.string().nullable(),
  slugs: z.record(nonemptyString, z.string()).nullable(),
  firstSeenAt: z.date(),
  lastSeenAt: z.date(),
});
export type Theatre = z.infer<typeof TheatreSchema>;

/** IUGG mean Earth radius in kilometres; this is a physical constant, not product policy. */
export const MEAN_EARTH_RADIUS_KM = 6371.0088;

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance on the IUGG mean-radius sphere, using the stable haversine form. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const left = GeoPointSchema.parse(a);
  const right = GeoPointSchema.parse(b);
  if (left.lat === right.lat && left.lng === right.lng) {
    return 0;
  }

  const latitudeDelta = radians(right.lat - left.lat);
  const longitudeDelta = radians(right.lng - left.lng);
  const leftLatitude = radians(left.lat);
  const rightLatitude = radians(right.lat);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const centralAngle = 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
  return MEAN_EARTH_RADIUS_KM * centralAngle;
}

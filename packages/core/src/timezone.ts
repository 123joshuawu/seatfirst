import { z } from "zod";

const nonemptyString = z.string().min(1);

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value === "UTC" || value.includes("/");
  } catch {
    return false;
  }
}

export const IanaTimezoneSchema = nonemptyString.refine(isIanaTimezone, {
  message: "timezone must be an IANA timezone identifier",
});
export type IanaTimezone = z.infer<typeof IanaTimezoneSchema>;

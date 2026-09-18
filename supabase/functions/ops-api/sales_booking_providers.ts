import { SalesBookingError } from "./sales_booking.ts";

/** Approved SMS path. Default hold. Fake execute is isolated tests only. */
export async function sendBookingSms(
  payload: Record<string, unknown>,
  opts: { execute: boolean; fake: boolean },
) {
  if (!opts.execute || !opts.fake) return { held: true, sent: false, provider: "held" };
  return { held: false, sent: true, provider: "fake", message_id: `fake-sms-${payload.contact_id || "x"}` };
}

/** Approved calendar write path. Default hold. Confirm must call this. */
export async function writeBookingCalendar(
  payload: Record<string, unknown>,
  opts: { execute: boolean; fake: boolean },
) {
  if (!opts.execute || !opts.fake) return { held: true, written: false, provider: "held" };
  if (!payload.start_iso) throw new SalesBookingError("calendar start required", 400, "calendar_start");
  return { held: false, written: true, provider: "fake", event_id: `fake-cal-${payload.case_id || "x"}` };
}

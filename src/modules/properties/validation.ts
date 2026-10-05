import { z } from "zod";
import { splitIcalUrls } from "@/utils/icalUrls";

// Nothing validated this endpoint's body before — every field just flowed
// through as a TS-only Partial<{...}> with no runtime check. Added now
// because BACKEND_CHANGES_ADMIN_CONTENT_REQUESTS.md §2 explicitly asks for
// maxGuests to be validated as a positive integer; the rest of the
// endpoint's existing fields are included too rather than leaving them as
// the one unvalidated exception.
export const updatePropertySchema = z.object({
  body: z.object({
    minNights: z.coerce.number().int().min(1).optional(),
    turnoverBufferDays: z.coerce.number().int().min(0).optional(),
    checkInTime: z.string().min(1).optional(),
    checkOutTime: z.string().min(1).optional(),
    // Channel-agnostic (Airbnb, Booking.com, …) despite the name. Each
    // element is split on whitespace/commas first, so two URLs pasted into
    // one line are stored as two entries rather than one unfetchable string.
    airbnbIcalImportUrls: z
      .array(z.string())
      .transform(splitIcalUrls)
      .pipe(z.array(z.string().url()))
      .optional(),
    transportEnabled: z.boolean().optional(),
    icalCheckoutDayBuffer: z.boolean().optional(),
    maxGuests: z.coerce.number().int().min(1).optional(),
  }),
});

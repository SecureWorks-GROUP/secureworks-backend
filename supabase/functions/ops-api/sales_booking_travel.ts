/** Travel time between two scope visits, from their locations. Pure: no reads.
 *
 * There is no routing API key configured for this backend, and the wiki
 * engine (`availability.py`) only ever used a fixed buffer, so this is a
 * documented straight-line estimate:
 *
 *   minutes = 5 + (straight-line km x 1.3 road factor) / 55 km/h x 60,
 *   rounded UP to the next 5 minutes.
 *
 * A location this table cannot place has no travel estimate. Contract:
 * docs/sales-booking-live-availability.md.
 */

export const SALES_BOOKING_TRAVEL_MODEL = Object.freeze({
  version: "straight-line-v3",
  basis: "straight_line_distance_between_suburb_points",
  road_factor: 1.3,
  speed_kmh: 55,
  fixed_minutes: 5,
  round_up_to_minutes: 5,
  same_suburb_minimum_minutes: 15,
  points_source:
    "median jobs.site_lat/site_lng per site_suburb, production, read 2026-09-24",
});

/** Visit length on site after arrival (owner, 24 Sep 2026: "we just need 30
 * minutes allowed on site and then travel time between the jobs"). */
export const SALES_BOOKING_ON_SITE_MINUTES = 30;

// Generated from production jobs.site_lat/site_lng (Nominatim geocodes),
// median per lower-cased site_suburb, read-only SELECT on 2026-09-24.
// Used only for straight-line travel estimates between visits.
export const PERTH_SUBURB_POINTS: Readonly<
  Record<string, readonly [number, number]>
> = Object.freeze({
  "alexander heights": [-31.8264, 115.8651],
  "applecross": [-32.0072, 115.8371],
  "ardross": [-32.0262, 115.8363],
  "armadale": [-32.1502, 115.996],
  "attadale": [-32.0314, 115.8013],
  "atwell": [-32.155, 115.8636],
  "aveley": [-31.7839, 115.9939],
  "balcatta": [-31.878, 115.8258],
  "baldivis": [-32.3294, 115.8033],
  "balga": [-31.8606, 115.8497],
  "ballajura": [-31.8438, 115.9059],
  "banksia grove": [-31.6994, 115.804],
  "bassendean": [-31.9027, 115.9429],
  "bateman": [-32.0469, 115.8498],
  "bayswater": [-31.9207, 115.8971],
  "bedford": [-31.9138, 115.8947],
  "beechboro": [-31.8756, 115.946],
  "beeliar": [-32.1352, 115.8192],
  "beldon": [-31.7789, 115.7549],
  "bennett springs": [-31.8577, 115.9372],
  "bertram": [-32.2468, 115.8462],
  "bibra lake": [-32.0878, 115.8141],
  "bicton": [-32.0211, 115.7888],
  "binningup": [-33.1549, 115.6924],
  "boddington": [-32.8031, 116.4725],
  "booragoon": [-32.0379, 115.8344],
  "brabham": [-31.8292, 115.9782],
  "bull creek": [-32.0604, 115.8722],
  "burns beach": [-31.729, 115.72],
  "butler": [-31.6357, 115.7036],
  "byford": [-32.2358, 116.0017],
  "canning vale": [-32.0791, 115.9233],
  "carine": [-31.8527, 115.7907],
  "carlisle": [-31.9707, 115.9163],
  "carramar": [-31.7077, 115.7948],
  "caversham": [-31.873, 115.9715],
  "city beach": [-31.9289, 115.7614],
  "claremont": [-31.9693, 115.7819],
  "clarkson": [-31.6745, 115.7253],
  "como": [-31.993, 115.8743],
  "connolly": [-31.7531, 115.7482],
  "coolbinia": [-31.9128, 115.8528],
  "cottesloe": [-32.006, 115.7534],
  "craigie": [-31.793, 115.765],
  "daglish": [-31.9561, 115.807],
  "dalkeith": [-31.9981, 115.7956],
  "darch": [-31.8076, 115.8438],
  "darling downs": [-32.2017, 115.9685],
  "dayton": [-31.8562, 115.9767],
  "dianella": [-31.8883, 115.8742],
  "doubleview": [-31.8984, 115.7788],
  "duncraig": [-31.8308, 115.7787],
  "edgewater": [-31.7677, 115.7864],
  "ellenbrook": [-31.7714, 115.9577],
  "erskine": [-32.5525, 115.7032],
  "falcon": [-32.587, 115.6512],
  "ferndale": [-32.0297, 115.9221],
  "floreat": [-31.9433, 115.7981],
  "forrestfield": [-31.9901, 115.9909],
  "furnissdale": [-32.5606, 115.7591],
  "gidgegannup": [-31.8325, 116.1235],
  "girrawheen": [-31.8396, 115.8303],
  "glendalough": [-31.9153, 115.8199],
  "gooseberry hill": [-31.9447, 116.0478],
  "greenfields": [-32.5288, 115.7559],
  "greenwood": [-31.831, 115.8049],
  "gwelup": [-31.8777, 115.7969],
  "halls head": [-32.5242, 115.6979],
  "hamilton hill": [-32.0836, 115.7877],
  "harrisdale": [-32.1195, 115.9293],
  "heathridge": [-31.7673, 115.7599],
  "herne hill": [-31.8221, 116.0479],
  "high wycombe": [-31.9487, 115.9951],
  "hillarys": [-31.807, 115.7421],
  "hillman": [-32.2813, 115.7613],
  "hocking": [-31.7735, 115.8173],
  "huntingdale": [-32.079, 115.9625],
  "iluka": [-31.7372, 115.7256],
  "inglewood": [-31.9184, 115.8922],
  "innaloo": [-31.8929, 115.7985],
  "jandakot": [-32.1142, 115.8611],
  "jindalee": [-31.6345, 115.6795],
  "jolimont": [-31.9438, 115.8086],
  "joondanna": [-31.9101, 115.8312],
  "kalamunda": [-31.9767, 116.0575],
  "kallaroo": [-31.7942, 115.7516],
  "kardinya": [-32.069, 115.8067],
  "karrinyup": [-31.8705, 115.7783],
  "kelmscott": [-32.1128, 116.022],
  "kensington": [-31.9861, 115.8816],
  "kingsley": [-31.8092, 115.7956],
  "kinross": [-31.7143, 115.74],
  "koondoola": [-31.843, 115.8588],
  "lake coogee": [-32.1224, 115.781],
  "landsdale": [-31.8124, 115.8619],
  "langford": [-32.0398, 115.9354],
  "lathlain": [-31.9672, 115.9121],
  "leederville": [-31.9319, 115.8426],
  "leeming": [-32.0821, 115.8607],
  "lesmurdie": [-31.9973, 116.0367],
  "lockridge": [-31.8807, 115.9481],
  "madeley": [-31.8011, 115.8189],
  "mandurah": [-32.5156, 115.7428],
  "manning": [-32.0081, 115.8688],
  "marangaroo": [-31.829, 115.8395],
  "maylands": [-31.9341, 115.8929],
  "melville": [-32.0365, 115.7982],
  "merriwa": [-31.6682, 115.7163],
  "midland": [-31.8797, 116.005],
  "mindarie": [-31.6869, 115.7067],
  "mirrabooka": [-31.8592, 115.8633],
  "morley": [-31.8841, 115.8977],
  "mosman park": [-32.0142, 115.7583],
  "mount lawley": [-31.9276, 115.8776],
  "mount pleasant": [-32.0185, 115.849],
  "mount richon": [-32.1657, 116.0183],
  "mullaloo": [-31.7727, 115.7438],
  "mundaring": [-31.8993, 116.1756],
  "munster": [-32.1482, 115.8113],
  "myalup": [-33.1027, 115.699],
  "nedlands": [-31.9749, 115.8115],
  "nollamara": [-31.8852, 115.8415],
  "noranda": [-31.8741, 115.8995],
  "north coogee": [-32.0865, 115.7604],
  "north perth": [-31.9333, 115.8513],
  "northam": [-31.8725, 116.2152],
  "ocean reef": [-31.7498, 115.7311],
  "orelia": [-32.2313, 115.8132],
  "padbury": [-31.8049, 115.7732],
  "palmyra": [-32.0403, 115.7799],
  "parmelia": [-32.245, 115.8249],
  "pearsall": [-31.7791, 115.8133],
  "peppermint grove": [-31.9997, 115.7643],
  "preston beach": [-32.8814, 115.6612],
  "queens park": [-32.0077, 115.9428],
  "quinns rocks": [-31.6672, 115.6992],
  "redcliffe": [-31.938, 115.9388],
  "riverton": [-32.0364, 115.8895],
  "rivervale": [-31.9587, 115.912],
  "rockingham": [-32.2873, 115.7231],
  "roleystone": [-32.1075, 116.07],
  "safety bay": [-32.2982, 115.7415],
  "samson": [-32.0731, 115.8017],
  "scarborough": [-31.8937, 115.7678],
  "seville grove": [-32.1416, 115.9788],
  "shoalwater": [-32.2915, 115.7049],
  "singleton": [-32.4373, 115.7609],
  "sorrento": [-31.8237, 115.7425],
  "south fremantle": [-32.07, 115.7554],
  "southern river": [-32.1008, 115.9549],
  "spearwood": [-32.1066, 115.7751],
  "st james": [-32.0, 115.9129],
  "stirling": [-31.8875, 115.807],
  "stratton": [-31.8641, 116.0386],
  "subiaco": [-31.9528, 115.8171],
  "success": [-32.1402, 115.8447],
  "swanbourne": [-31.9776, 115.766],
  "tapping": [-31.7133, 115.8012],
  "the vines": [-31.7696, 116.0011],
  "thornlie": [-32.0691, 115.9559],
  "tuart hill": [-31.9022, 115.8341],
  "two rocks": [-31.4866, 115.5975],
  "victoria park": [-31.9749, 115.8866],
  "waikiki": [-32.325, 115.7577],
  "wanneroo": [-31.759, 115.8004],
  "warnbro": [-32.3347, 115.7655],
  "wembley": [-31.9351, 115.8054],
  "west leederville": [-31.9386, 115.8323],
  "west perth": [-31.9418, 115.847],
  "white gum valley": [-32.0598, 115.7654],
  "willetton": [-32.0617, 115.891],
  "winthrop": [-32.0464, 115.8238],
  "woodbridge": [-31.8912, 115.9961],
  "woodvale": [-31.7854, 115.787],
  "yanchep": [-31.5625, 115.6395],
  "yangebup": [-32.1243, 115.8134],
  "yokine": [-31.8909, 115.8494],
});

function clean(value: string): string {
  return value.toLowerCase().replace(/[’`]/g, "'")
    .replace(/\b(?:western australia|wa)\b/g, " ")
    .replace(/\b\d{4}\b/g, " ").replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ").trim().replace(/^mt /, "mount ");
}

export interface SuburbPoint {
  suburb: string;
  lat: number;
  lng: number;
}

export function salesBookingSuburbPoint(value: unknown): SuburbPoint | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const withoutRegion = value.trim()
    .replace(/[,\s]+Australia$/i, "")
    .replace(/[,\s]+(?:WA|Western Australia)?\s*\d{4}$/i, "")
    .replace(/[,\s]+(?:WA|Western Australia)$/i, "");
  let locality = withoutRegion.split(",").at(-1)!.trim();
  if (/\d/.test(locality)) {
    const street = locality.match(
      /^.*\b(?:street|st|road|rd|avenue|ave|drive|dr|way|court|ct|close|cl|crescent|cres|terrace|tce|parade|pde|place|pl|lane|ln)\s+(.+)$/i,
    );
    if (!street) return null;
    locality = street[1];
  }
  const name = clean(locality).replace(/\bmt\b/g, "mount");
  const point = PERTH_SUBURB_POINTS[name];
  return point ? { suburb: name, lat: point[0], lng: point[1] } : null;
}

export function salesBookingSuburbByUnambiguousContact(
  cases: ReadonlyArray<{
    contact_id?: unknown;
    suburb?: unknown;
  }>,
): Map<string, string> {
  const suburbsByContact = new Map<string, Set<string>>();
  for (const row of cases) {
    if (typeof row.contact_id !== "string" || !row.contact_id.trim()) continue;
    const contactId = row.contact_id.trim();
    const suburb = salesBookingSuburbPoint(row.suburb)?.suburb ?? "";
    const suburbs = suburbsByContact.get(contactId) ?? new Set<string>();
    suburbs.add(suburb);
    suburbsByContact.set(contactId, suburbs);
  }
  const result = new Map<string, string>();
  for (const [contactId, suburbs] of suburbsByContact) {
    if (suburbs.size !== 1 || suburbs.has("")) continue;
    result.set(contactId, [...suburbs][0]);
  }
  return result;
}

function normalizedSpecificAddress(
  value: unknown,
  suburb: string,
): string | null {
  if (typeof value !== "string" || !/\d/.test(value)) return null;
  const escapedSuburb = suburb.split(/\s+/).map((part) =>
    part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ).join("\\s+");
  const normalized = value.toLowerCase()
    .replace(/\bwestern australia\b|\bwa\b/g, " ")
    .replace(/\b\d{4}\b/g, " ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const detail = normalized.replace(
    new RegExp(`\\b${escapedSuburb}\\b`, "g"),
    " ",
  ).replace(/\s+/g, " ").trim();
  return /\d/.test(detail) && /[a-z]{2}/i.test(detail)
    ? `${detail}, ${suburb}`
    : null;
}

function km(a: SuburbPoint, b: SuburbPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export interface TravelEstimate {
  minutes: number | null;
  basis: "straight_line" | "same_suburb_minimum" | "unknown_location";
  km: number | null;
  from: string | null;
  to: string | null;
}

/** Minutes to allow between a visit at `from` and one at `to`. */
export function salesBookingTravelMinutes(
  from: unknown,
  to: unknown,
): TravelEstimate {
  const m = SALES_BOOKING_TRAVEL_MODEL;
  const a = salesBookingSuburbPoint(from), b = salesBookingSuburbPoint(to);
  if (!a || !b) {
    return {
      minutes: null,
      basis: "unknown_location",
      km: null,
      from: a?.suburb ?? null,
      to: b?.suburb ?? null,
    };
  }
  if (a.suburb === b.suburb) {
    const fromAddress = normalizedSpecificAddress(from, a.suburb);
    const toAddress = normalizedSpecificAddress(to, b.suburb);
    if (!fromAddress || fromAddress !== toAddress) {
      return {
        minutes: m.same_suburb_minimum_minutes,
        basis: "same_suburb_minimum",
        km: null,
        from: a.suburb,
        to: b.suburb,
      };
    }
  }
  const distance = km(a, b);
  const raw = m.fixed_minutes + distance * m.road_factor / m.speed_kmh * 60;
  return {
    minutes: Math.ceil(raw / m.round_up_to_minutes) * m.round_up_to_minutes,
    basis: "straight_line",
    km: Math.round(distance * 10) / 10,
    from: a.suburb,
    to: b.suburb,
  };
}

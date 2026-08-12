/**
 * Room opening hours resolution.
 *
 * A room's weekly hours come from one of two places:
 *
 *   - `Room.availability` is set  → an explicit per-room override.
 *   - `Room.availability` is NULL → inherit `Location.openingHours`.
 *
 * Inheritance rather than copying the venue's hours into each room: a
 * copy loses the distinction between "this room was deliberately given
 * its own hours" and "nobody ever set this room up", so the next change
 * at the venue has no way to know which rooms it may safely update.
 * With a null marker the answer stays recorded, and a venue-level edit
 * reaches every inheriting room for free.
 *
 * `{}` is NOT the same as null — it's an override meaning "open at no
 * time". That distinction is why the 20260811150000 migration only
 * nulled rooms that already held `{}` (which was the old default for
 * "unset"), and left rooms with real windows alone.
 */

export type AvailabilityWindow = { start: string; end: string };

/** Keyed by Date.getDay() as a string: "0" = Sunday … "6" = Saturday. */
export type WeeklyAvailability = Record<string, AvailabilityWindow[]>;

type RoomLike = { availability?: unknown } | null | undefined;
type LocationLike = { openingHours?: unknown } | null | undefined;

/** True when this room follows its venue's hours rather than its own. */
export function roomInheritsHours(room: RoomLike): boolean {
  return room?.availability == null;
}

/**
 * The hours actually in force for a room. Always returns an object, so
 * callers can index it without a null check; an empty object means
 * "no window configured anywhere", which every consumer already treats
 * as "don't constrain".
 */
export function resolveRoomAvailability(
  room: RoomLike,
  location: LocationLike,
): WeeklyAvailability {
  const own = room?.availability;
  if (own != null && typeof own === 'object') {
    return own as WeeklyAvailability;
  }
  const inherited = location?.openingHours;
  if (inherited != null && typeof inherited === 'object') {
    return inherited as WeeklyAvailability;
  }
  return {};
}

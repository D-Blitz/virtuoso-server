import prisma from '../prisma';
import { isBefore } from 'date-fns';

import {
  resolveRoomAvailability,
  roomInheritsHours,
} from '../domain/availability/roomAvailability';

export type ValidationType = 'error' | 'warning';

export type ValidationCode =
  | 'TIME_ERROR'
  | 'MISSING_FACILITATOR'
  | 'MISSING_CLIENT'
  | 'MISSING_ROOM'
  | 'MISSING_LOCATION'
  | 'ROOM_LOCATION_MISMATCH'
  | 'NEGATIVE_PRICE'
  | 'ROOM_CONFLICT'
  | 'FACILITATOR_CONFLICT'
  | 'CLIENT_CONFLICT'
  | 'ROOM_UNAVAILABLE'
  | 'FACILITATOR_UNAVAILABLE'
  | 'FACILITATOR_LOCATION_MISMATCH'
  | 'SERVICE_NOT_OFFERED'
  | 'PRICE_MISMATCH'
  // N.4 — Unavailability conflicts. Distinct from *_UNAVAILABLE (which
  // means "no weekly window declared") and *_CONFLICT (which means
  // "another booking is already there"). _BLOCKED means an admin
  // explicitly marked this time as unavailable.
  | 'ROOM_BLOCKED'
  | 'FACILITATOR_BLOCKED';

export interface ValidationIssue {
  type: ValidationType;
  code: ValidationCode;
  message: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
}

export interface ScheduledEventInput {
  id?: string;
  startTime: string;
  endTime: string;
  roomId?: string | null;
  locationId?: string | null;
  serviceId?: string | null;
  price: number;
  facilitators?: string[];
  clients?: string[];
}
 
// ------------ helpers ------------

type Slot = { start: string; end: string };

function hhmmToMin(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isWithinAnyWindow(eStartMin: number, eEndMin: number, daySlots: Slot[]): boolean {
  for (const { start, end } of daySlots) {
    const sMin = hhmmToMin(start);
    const eMin = hhmmToMin(end);
    if (Number.isFinite(sMin) && Number.isFinite(eMin) && eMin > sMin) {
      if (eStartMin >= sMin && eEndMin <= eMin) return true;
    }
  }
  return false;
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

export async function validateScheduledEvent(rawInput: ScheduledEventInput): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  // ---- Normalize / coerce fields (defensive) ----
  const facilitators = asArray((rawInput as any).facilitatorIds ?? rawInput.facilitators);
  const clients      = asArray((rawInput as any).clientIds ?? rawInput.clients);

  const id          = rawInput.id ?? undefined;
  const startTime   = rawInput.startTime;
  const endTime     = rawInput.endTime;
  const price       = typeof rawInput.price === 'number' ? rawInput.price : Number(rawInput.price);
  const roomId      = rawInput.roomId ?? undefined;
  const locationId  = rawInput.locationId ?? undefined;
  const serviceId   = rawInput.serviceId ?? undefined;

  // ---- Basic pre-checks before hitting DB ----
  const start = new Date(startTime);
  const end   = new Date(endTime);

  if (!(start instanceof Date) || isNaN(start.getTime()) || !(end instanceof Date) || isNaN(end.getTime())) {
    return {
      issues: [{
        type: 'error',
        code: 'TIME_ERROR',
        message: `L'heure de début et/ou l'heure de fin est invalide.`,
      }],
    };
  }

  if (!isBefore(start, end)) {
    return {
      issues: [{
        type: 'error',
        code: 'TIME_ERROR',
        message: `L'heure de début doit précéder l'heure de fin.`,
      }],
    };
  }

  if (!roomId) {
    return {
      issues: [{
        type: 'error',
        code: 'MISSING_ROOM',
        message: `Aucune salle n'est sélectionnée.`,
      }],
    };
  }

  if (!locationId) {
    return {
      issues: [{
        type: 'error',
        code: 'MISSING_LOCATION',
        message: `Aucun établissement n'est sélectionné.`,
      }],
    };
  }

  if (facilitators.length === 0) {
    return {
      issues: [{
        type: 'error',
        code: 'MISSING_FACILITATOR',
        message: `Aucun intervenant n'est assigné à l'événement.`,
      }],
    };
  }

  if (clients.length === 0) {
    return {
      issues: [{
        type: 'error',
        code: 'MISSING_CLIENT',
        message: `Aucun élève n'est assigné à l'événement.`,
      }],
    };
  }

  if (!(price >= 0)) {
    return {
      issues: [{
        type: 'error',
        code: 'NEGATIVE_PRICE',
        message: `Le tarif ne peut pas être négatif.`,
      }],
    };
  }

  // Compute weekday and local minutes-of-day for the event
  const weekday = String(start.getDay()); // 0..6 (local)
  const eventStartMin = start.getHours() * 60 + start.getMinutes();
  const eventEndMin   = end.getHours() * 60 + end.getMinutes();

  // Fetch data (defensive on service)
  const servicePromise = serviceId
    ? prisma.service.findUnique({ where: { id: serviceId }, include: { facilitators: true } })
    : Promise.resolve(null);

  const [room, location, facilitatorList, clientList, service] = await Promise.all([
    prisma.room.findUnique({ where: { id: roomId }, include: { location: true } }),
    prisma.location.findUnique({ where: { id: locationId } }),
    prisma.facilitator.findMany({ where: { id: { in: facilitators } }, include: { locations: true } }),
    prisma.client.findMany({ where: { id: { in: clients } } }),
    servicePromise,
  ]);

  if (!room) {
    return {
      issues: [{
        type: 'error',
        code: 'MISSING_ROOM',
        message: `Aucune salle valide trouvée.`,
      }],
    };
  }

  if (!location) {
    return {
      issues: [{
        type: 'error',
        code: 'MISSING_LOCATION',
        message: `Aucun établissement valide trouvé.`,
      }],
    };
  }

  if (room.locationId !== location.id) {
    issues.push({
      type: 'error',
      code: 'ROOM_LOCATION_MISMATCH',
      message: `La salle "${room.name}" n'appartient pas à l’établissement "${location.name}".`,
    });
    return { issues };
  }

  // ---- Room warnings ----
  // Hours come from the room's own override, or the venue's opening
  // hours when the room inherits (availability === null). Resolved in
  // one place so the two sources can't drift — see
  // domain/availability/roomAvailability.
  {
    const avail = resolveRoomAvailability(room, location) as Record<
      string,
      Slot[]
    >;
    const daySlots = Array.isArray(avail?.[weekday]) ? avail[weekday] : [];

    if (daySlots.length > 0) {
      const isRoomAvailable = isWithinAnyWindow(eventStartMin, eventEndMin, daySlots);
      if (!isRoomAvailable) {
        // Name the venue when the constraint came from it, so the admin
        // knows where to go and change it.
        const source = roomInheritsHours(room)
          ? `L’établissement "${location.name}" n'est pas ouvert à cette heure.`
          : `La salle "${room.name}" n'est pas disponible à cette heure.`;
        issues.push({
          type: 'warning',
          code: 'ROOM_UNAVAILABLE',
          message: source,
        });
      }
    }
  }

  const conflictingRoomEvents = await prisma.scheduledEvent.findMany({
    where: {
      id: { not: id ?? '' },
      roomId: room.id,
      startTime: { lt: end },
      endTime: { gt: start },
    },
  });

  if ((conflictingRoomEvents ?? []).length > 0) {
    issues.push({
      type: 'warning',
      code: 'ROOM_CONFLICT',
      message: `La salle "${room.name}" est déjà réservée pendant ce créneau.`,
    });
  }

  // ---- N.4 Unavailability — room + facilitator + location blocks -----
  // One query covers all three target types. Trashed rows are filtered
  // by the scoping extension (so deleted blocks don't haunt the admin).
  // A location-block at this event's location surfaces as a ROOM_BLOCKED
  // warning — admins see "ce créneau est bloqué" without needing to
  // distinguish whether the block was placed on the room or the location.
  const blocking = await prisma.unavailability.findMany({
    where: {
      startTime: { lt: end },
      endTime: { gt: start },
      OR: [
        { roomId: room.id },
        { locationId: location.id },
        ...(facilitators.length > 0
          ? [{ facilitatorId: { in: facilitators } }]
          : []),
      ],
    },
    select: {
      roomId: true,
      facilitatorId: true,
      locationId: true,
      reason: true,
    },
  });

  if (blocking.some((b) => b.roomId === room.id)) {
    issues.push({
      type: 'warning',
      code: 'ROOM_BLOCKED',
      message: `La salle "${room.name}" est marquée indisponible sur ce créneau.`,
    });
  }
  if (blocking.some((b) => b.locationId === location.id)) {
    issues.push({
      type: 'warning',
      code: 'ROOM_BLOCKED',
      message: `L’établissement "${location.name}" est marqué indisponible sur ce créneau.`,
    });
  }

  // ---- Facilitator warnings (only for selected facilitators) ----
  for (const facilitatorId of facilitators) {
    const facilitator = facilitatorList.find(f => f.id === facilitatorId);
    if (!facilitator) continue;

    const availability = facilitator.availability as Record<string, Slot[]> | undefined;
    const daySlots = Array.isArray(availability?.[weekday]) ? availability![weekday] : [];

    if (daySlots.length > 0) {
      const isAvailable = isWithinAnyWindow(eventStartMin, eventEndMin, daySlots);
      if (!isAvailable) {
        issues.push({
          type: 'warning',
          code: 'FACILITATOR_UNAVAILABLE',
          message: `L'intervenant ${facilitator.firstname} ${facilitator.lastname} n'est pas disponible à cette heure.`,
        });
      }
    }

    const facilitatorConflicts = await prisma.scheduledEvent.findMany({
      where: {
        id: { not: id ?? '' },
        facilitators: { some: { id: facilitator.id } },
        startTime: { lt: end },
        endTime: { gt: start },
      },
    });

    if ((facilitatorConflicts ?? []).length > 0) {
      issues.push({
        type: 'warning',
        code: 'FACILITATOR_CONFLICT',
        message: `L'intervenant ${facilitator.firstname} ${facilitator.lastname} a déjà un événement à cette heure.`,
      });
    }

    if (blocking.some((b) => b.facilitatorId === facilitator.id)) {
      issues.push({
        type: 'warning',
        code: 'FACILITATOR_BLOCKED',
        message: `L'intervenant ${facilitator.firstname} ${facilitator.lastname} est marqué indisponible sur ce créneau.`,
      });
    }

    const isAssigned = facilitator.locations.some(loc => loc.id === location.id);
    if (!isAssigned) {
      issues.push({
        type: 'warning',
        code: 'FACILITATOR_LOCATION_MISMATCH',
        message: `L'intervenant ${facilitator.firstname} ${facilitator.lastname} n'est pas assigné à l'établissement "${location.name}".`,
      });
    }

    if (service && !service.facilitators.some(f => f.id === facilitator.id)) {
      issues.push({
        type: 'warning',
        code: 'SERVICE_NOT_OFFERED',
        message: `L'intervenant ${facilitator.firstname} ${facilitator.lastname} ne propose pas la prestation "${service.name}".`,
      });
    }
  }

  // ---- Client warnings (only for selected clients) ----
  for (const clientId of clients) {
    const client = clientList.find(c => c.id === clientId);
    if (!client) continue;

    const clientConflicts = await prisma.scheduledEvent.findMany({
      where: {
        id: { not: id ?? '' },
        clients: { some: { id: client.id } },
        startTime: { lt: end },
        endTime: { gt: start },
      },
    });

    if ((clientConflicts ?? []).length > 0) {
      issues.push({
        type: 'warning',
        code: 'CLIENT_CONFLICT',
        message: `L'élève ${client.firstname} ${client.lastname} a déjà un événement à cette heure.`,
      });
    }
  }

  // ---- Price mismatch ----
  if (service && typeof service.defaultPrice === 'number' && price !== service.defaultPrice) {
    issues.push({
      type: 'warning',
      code: 'PRICE_MISMATCH',
      message: `Le tarif personnalisé (${price} €) est différent du tarif habituel de la prestation "${service.name}" (${service.defaultPrice} €).`,
    });
  }

  return { issues };
}

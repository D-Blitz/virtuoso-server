import prisma from '@/prisma';
import { isBefore } from 'date-fns';

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
  | 'PRICE_MISMATCH';

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
  if (room && typeof room.availability === 'object' && room.availability !== null) {
    const avail = room.availability as Record<string, Slot[]>;
    const daySlots = Array.isArray(avail?.[weekday]) ? avail[weekday] : [];

    if (daySlots.length > 0) {
      const isRoomAvailable = isWithinAnyWindow(eventStartMin, eventEndMin, daySlots);
      if (!isRoomAvailable) {
        issues.push({
          type: 'warning',
          code: 'ROOM_UNAVAILABLE',
          message: `La salle "${room.name}" n'est pas disponible à cette heure.`,
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

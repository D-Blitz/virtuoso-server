import prisma from '../prisma';

/**
 * Counts what *active* (non-trashed) rows currently reference a given
 * entity. Powers the "delete impact preview" modal: before soft-
 * deleting a Client/Facilitator/Room/Location/Service, the admin sees
 * how many events / enrollments depend on it.
 *
 * v1 policy (informational, not blocking):
 *   - Soft-deleting the parent doesn't touch these dependents — they
 *     keep their FK / m2m link but the parent becomes hidden by the
 *     Prisma scoping extension, which is why the event UI shows a
 *     "« Supprimé »" placeholder for the missing relation.
 *   - Counts are returned so the admin can confirm with full
 *     visibility. We may switch to a "block" policy later.
 *
 * Returned shape is a flat list of {label, count} so the admin UI can
 * just render them as bullets. Labels are French (admin UI language).
 */

export type DependentRow = { label: string; count: number };

export class DependentsService {
  /**
   * Entry point — dispatches to the per-type implementation. Throws on
   * unknown entityType so the caller can surface a 400.
   */
  async countFor(entityType: string, id: string): Promise<DependentRow[]> {
    switch (entityType) {
      case 'Client':
        return this.client(id);
      case 'Facilitator':
        return this.facilitator(id);
      case 'Room':
        return this.room(id);
      case 'Location':
        return this.location(id);
      case 'Service':
        return this.service(id);
      case 'ServiceCategory':
        return this.serviceCategory(id);
      case 'Term':
        return this.term(id);
      case 'Tag':
        return this.tag(id);
      default:
        throw new Error(`No dependents mapping for entityType: ${entityType}`);
    }
  }

  private async client(id: string): Promise<DependentRow[]> {
    const now = new Date();
    const [eventsTotal, eventsUpcoming, enrollments] = await Promise.all([
      prisma.scheduledEvent.count({
        where: { clients: { some: { id } } },
      }),
      prisma.scheduledEvent.count({
        where: { clients: { some: { id } }, startTime: { gte: now } },
      }),
      prisma.enrollment.count({ where: { clientId: id } }),
    ]);
    return condense([
      { label: 'Événements', count: eventsTotal },
      { label: 'Événements à venir', count: eventsUpcoming },
      { label: 'Inscriptions', count: enrollments },
    ]);
  }

  private async facilitator(id: string): Promise<DependentRow[]> {
    const now = new Date();
    const [eventsTotal, eventsUpcoming, enrollments] = await Promise.all([
      prisma.scheduledEvent.count({
        where: { facilitators: { some: { id } } },
      }),
      prisma.scheduledEvent.count({
        where: { facilitators: { some: { id } }, startTime: { gte: now } },
      }),
      prisma.enrollment.count({ where: { facilitatorId: id } }),
    ]);
    return condense([
      { label: 'Événements', count: eventsTotal },
      { label: 'Événements à venir', count: eventsUpcoming },
      { label: 'Inscriptions', count: enrollments },
    ]);
  }

  private async room(id: string): Promise<DependentRow[]> {
    const now = new Date();
    const [eventsTotal, eventsUpcoming, enrollments] = await Promise.all([
      prisma.scheduledEvent.count({ where: { roomId: id } }),
      prisma.scheduledEvent.count({
        where: { roomId: id, startTime: { gte: now } },
      }),
      prisma.enrollment.count({ where: { roomId: id } }),
    ]);
    return condense([
      { label: 'Événements', count: eventsTotal },
      { label: 'Événements à venir', count: eventsUpcoming },
      { label: 'Inscriptions', count: enrollments },
    ]);
  }

  private async location(id: string): Promise<DependentRow[]> {
    const now = new Date();
    const [rooms, eventsTotal, eventsUpcoming, enrollments, terms, closures] =
      await Promise.all([
        prisma.room.count({ where: { locationId: id } }),
        prisma.scheduledEvent.count({ where: { locationId: id } }),
        prisma.scheduledEvent.count({
          where: { locationId: id, startTime: { gte: now } },
        }),
        prisma.enrollment.count({ where: { locationId: id } }),
        prisma.term.count({ where: { locationId: id } }),
        prisma.closure.count({ where: { locationId: id } }),
      ]);
    return condense([
      { label: 'Salles', count: rooms },
      { label: 'Événements', count: eventsTotal },
      { label: 'Événements à venir', count: eventsUpcoming },
      { label: 'Inscriptions', count: enrollments },
      { label: 'Trimestres', count: terms },
      { label: 'Fermetures', count: closures },
    ]);
  }

  private async service(id: string): Promise<DependentRow[]> {
    const now = new Date();
    const [eventsTotal, eventsUpcoming, enrollments] = await Promise.all([
      prisma.scheduledEvent.count({ where: { serviceId: id } }),
      prisma.scheduledEvent.count({
        where: { serviceId: id, startTime: { gte: now } },
      }),
      prisma.enrollment.count({ where: { serviceId: id } }),
    ]);
    return condense([
      { label: 'Événements', count: eventsTotal },
      { label: 'Événements à venir', count: eventsUpcoming },
      { label: 'Inscriptions', count: enrollments },
    ]);
  }

  private async serviceCategory(id: string): Promise<DependentRow[]> {
    const [services, events] = await Promise.all([
      prisma.service.count({ where: { serviceCategoryId: id } }),
      prisma.scheduledEvent.count({ where: { serviceCategoryId: id } }),
    ]);
    return condense([
      { label: 'Prestations', count: services },
      { label: 'Événements', count: events },
    ]);
  }

  private async term(id: string): Promise<DependentRow[]> {
    const [enrollments] = await Promise.all([
      prisma.enrollment.count({ where: { termId: id } }),
    ]);
    return condense([{ label: 'Inscriptions', count: enrollments }]);
  }

  private async tag(id: string): Promise<DependentRow[]> {
    const [events, facilitators] = await Promise.all([
      prisma.scheduledEvent.count({ where: { tags: { some: { id } } } }),
      prisma.facilitator.count({ where: { tags: { some: { id } } } }),
    ]);
    return condense([
      { label: 'Événements', count: events },
      { label: 'Intervenants', count: facilitators },
    ]);
  }
}

/** Drop zero-count rows so the modal doesn't show noise. */
function condense(rows: DependentRow[]): DependentRow[] {
  return rows.filter((r) => r.count > 0);
}

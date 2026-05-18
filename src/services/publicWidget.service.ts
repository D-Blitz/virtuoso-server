import prisma from '../prisma';
import type { Prisma } from '@prisma/client';

/**
 * Public-facing config payload for the embeddable widget.
 *
 * Returns ONLY published, non-sensitive fields. Internal admin metadata
 * (notes, organizationId, internal IDs the host site shouldn't see) are
 * deliberately omitted.
 */
export class PublicWidgetService {
  async getConfig(widget: {
    id: string;
    slug: string;
    publishableKey: string;
    isPublished: boolean;
    serviceIds: string[];
    locationId: string | null;
    publishedConfig: Prisma.JsonValue;
    organizationId: string;
  }) {
    if (!widget.isPublished || !widget.publishedConfig) {
      return null;
    }

    // Fetch services exposed by this widget.
    // Empty serviceIds = expose all org services.
    const services = await prisma.service.findMany({
      where:
        widget.serviceIds.length > 0
          ? { id: { in: widget.serviceIds } }
          : {},
      select: {
        id: true,
        name: true,
        description: true,
        defaultPrice: true,
        defaultDurationMinutes: true,
        serviceCategoryId: true,
      },
    });

    // Fetch service categories for grouping in the UI (if needed).
    const categoryIds = Array.from(new Set(services.map((s) => s.serviceCategoryId)));
    const categories = categoryIds.length
      ? await prisma.serviceCategory.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true, description: true },
        })
      : [];

    return {
      slug: widget.slug,
      publishableKey: widget.publishableKey,
      config: widget.publishedConfig,
      services,
      categories,
    };
  }
}

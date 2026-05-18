import { randomBytes } from 'crypto';
import prisma from '../prisma';
import { getOrganizationId } from '../auth/context';

/**
 * Default WidgetConfig payload used for the `draftConfig` JSON column on
 * newly-created widgets. The admin form can then edit any of these.
 *
 * Kept in sync with the WidgetConfig type the admin client uses.
 */
const DEFAULT_DRAFT_CONFIG = {
  theme: {
    primaryColor: '#111111',
    accentColor: '#7C3AED',
    fontFamily: 'system-ui, sans-serif',
    radius: 8,
  },
  layout: {
    stepsEnabled: [
      'service',
      'level',
      'languages',
      'age',
      'identity',
      'slot',
      'teacher',
      'recap',
      'payment',
      'confirmation',
    ],
    copyOverrides: {},
  },
  recommenderWeights: {
    ageMatch: 1.0,
    levelMatch: 1.0,
    priorityWeightMultiplier: 1.0,
  },
  defaultLocale: 'fr-FR',
  cgvVersion: '1.0',
  cgvUrl: '',
};

function generatePublishableKey(): string {
  return `pk_${randomBytes(16).toString('hex')}`;
}

export type WidgetCreateInput = {
  slug: string;
  allowedOrigins?: string[];
  serviceIds?: string[];
  locationId?: string | null;
  draftConfig?: Record<string, unknown>;
};

export type WidgetUpdateInput = Partial<{
  slug: string;
  allowedOrigins: string[];
  serviceIds: string[];
  locationId: string | null;
  draftConfig: Record<string, unknown>;
  isPublished: boolean;
}>;

export class WidgetService {
  async list() {
    return prisma.bookingWidget.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string) {
    return prisma.bookingWidget.findFirst({ where: { id } });
  }

  async create(data: WidgetCreateInput) {
    const organizationId = getOrganizationId()!;
    return prisma.bookingWidget.create({
      data: {
        organizationId,
        slug: data.slug,
        publishableKey: generatePublishableKey(),
        allowedOrigins: data.allowedOrigins ?? [],
        serviceIds: data.serviceIds ?? [],
        locationId: data.locationId ?? null,
        draftConfig: (data.draftConfig as object) ?? DEFAULT_DRAFT_CONFIG,
      },
    });
  }

  async update(id: string, data: WidgetUpdateInput) {
    return prisma.bookingWidget.update({
      where: { id },
      data: {
        ...(data.slug !== undefined && { slug: data.slug }),
        ...(data.allowedOrigins !== undefined && {
          allowedOrigins: data.allowedOrigins,
        }),
        ...(data.serviceIds !== undefined && { serviceIds: data.serviceIds }),
        ...(data.locationId !== undefined && { locationId: data.locationId }),
        ...(data.draftConfig !== undefined && {
          draftConfig: data.draftConfig as object,
        }),
        ...(data.isPublished !== undefined && { isPublished: data.isPublished }),
      },
    });
  }

  /**
   * Promote `draftConfig` to `publishedConfig` and flip `isPublished` to true.
   * Idempotent — re-publishing just re-snapshots the current draft.
   */
  async publish(id: string) {
    const widget = await prisma.bookingWidget.findFirst({ where: { id } });
    if (!widget) throw new Error('Widget not found');
    return prisma.bookingWidget.update({
      where: { id },
      data: {
        publishedConfig: widget.draftConfig as object,
        isPublished: true,
      },
    });
  }

  async unpublish(id: string) {
    return prisma.bookingWidget.update({
      where: { id },
      data: { isPublished: false },
    });
  }

  async delete(id: string) {
    return prisma.bookingWidget.delete({ where: { id } });
  }
}

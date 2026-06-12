import Anthropic from '@anthropic-ai/sdk';

import prisma from '../../prisma';
import { getContext, getOrganizationId } from '../../auth/context';

/**
 * A.1 — AI assistant (v1: context-stuffed chat).
 *
 * Each turn we inject a compact, ORG-SCOPED snapshot of live data into
 * the system prompt (today's events, headline counts) and forward the
 * conversation to Claude. No fine-tuning involved — the model "knows"
 * the app because we tell it, fresh, every call. v2 upgrade path:
 * tool-use (the model calls server functions on demand) for arbitrary
 * lookups instead of a fixed snapshot.
 *
 * Runs behind requireUser: the caller's org/permissions scope every
 * query exactly like the rest of the API.
 */

const MODEL = 'claude-sonnet-4-6';

export type AssistantMessage = { role: 'user' | 'assistant'; content: string };

async function buildOrgSnapshot(): Promise<string> {
  const organizationId = getOrganizationId();
  if (!organizationId) return '';

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const [org, todayEvents, clientCount, facilitatorCount] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    }),
    prisma.scheduledEvent.findMany({
      where: {
        organizationId,
        startTime: { gte: dayStart, lt: dayEnd },
      },
      orderBy: { startTime: 'asc' },
      take: 25,
      include: {
        facilitators: { select: { firstname: true, lastname: true } },
        room: { select: { name: true } },
        service: { select: { name: true } },
      },
    }),
    prisma.client.count({ where: { organizationId } }),
    prisma.facilitator.count({ where: { organizationId } }),
  ]);

  const fmt = (d: Date) =>
    d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  const eventLines = todayEvents
    .map((e) => {
      const who =
        e.facilitators
          ?.map((f) => `${f.firstname} ${f.lastname}`)
          .join(', ') || '—';
      return `- ${fmt(new Date(e.startTime))}–${fmt(new Date(e.endTime))} · ${
        e.service?.name ?? 'Événement'
      } · ${who}${e.room?.name ? ` · ${e.room.name}` : ''}${
        e.status === 'CANCELED' ? ' · (annulé)' : ''
      }`;
    })
    .join('\n');

  return [
    `Organisation : ${org?.name ?? '—'}`,
    `Clients actifs : ${clientCount} · Intervenants : ${facilitatorCount}`,
    `Événements aujourd'hui (${todayEvents.length}) :`,
    eventLines || '- (aucun)',
  ].join('\n');
}

export class AssistantService {
  async chat(messages: AssistantMessage[]): Promise<string> {
    const ctx = getContext();
    if (!ctx) throw new Error('No context');

    // A.1b — free demo mode: without an API key, answer with the live
    // snapshot itself. Tests the whole pipeline (auth, org scoping,
    // data fetch, drawer) at zero cost; the key only unlocks reasoning.
    if (!process.env.ANTHROPIC_API_KEY) {
      const demo = await buildOrgSnapshot();
      return (
        'Mode démo — aucune clé API configurée, mais je lis déjà vos ' +
        'données en direct :\n\n' +
        demo +
        '\n\nAjoutez ANTHROPIC_API_KEY au serveur pour des réponses ' +
        'intelligentes.'
      );
    }

    const snapshot = await buildOrgSnapshot();
    const client = new Anthropic();

    const system = [
      "Tu es l'assistant intégré d'Artcetera, une plateforme de gestion",
      "de planning et de réservations (événements, clients, intervenants,",
      'salles, factures). Réponds en français, de façon concise et',
      "actionnable. Utilise un vocabulaire neutre (« événement », jamais",
      '« cours »). Si une question dépasse les données fournies, dis-le',
      'simplement et suggère où regarder dans l\'application.',
      '',
      'Données en direct (périmètre de l\'organisation de l\'utilisateur) :',
      snapshot,
    ].join('\n');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: messages.slice(-12).map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return text || 'Je n\'ai pas de réponse — reformulez peut-être ?';
  }
}

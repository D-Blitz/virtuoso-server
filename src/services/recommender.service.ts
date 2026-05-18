import prisma from '../prisma';

/**
 * Pure scoring + ranking for the booking widget.
 *
 * Default-when-empty convention (matches the admin form copy):
 *   - explicit score 0           → exclude from results
 *   - explicit score in (0..1]   → matching strength
 *   - empty array / missing key  → NEUTRAL (0.5), never exclusion
 *
 * Languages:
 *   - facilitator.languages empty   → treat as polyglot (no demotion)
 *   - non-empty + at least one match → speaker
 *   - non-empty + no overlap         → non-speaker (filtered or appended-with-flag,
 *                                                  depending on acceptNonNativeSpeaker)
 */

export type Level = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';

export type RecommenderInput = {
  serviceId: string;
  level: Level;
  languages: string[];
  studentAge: number;
  acceptNonNativeSpeaker: boolean;
  locationId?: string;
  weights: {
    ageMatch: number;
    levelMatch: number;
    priorityWeightMultiplier: number;
  };
};

export type Candidate = {
  facilitatorId: string;
  score: number;
  breakdown: {
    ageScore: number;
    levelScore: number;
    priorityWeight: number;
  };
  speaksRequestedLanguage: boolean;
  publicProfile: {
    firstname: string;
    lastname: string;
    bio: string | null;
    profilePictureUrl: string | null;
  };
};

export type RecommenderResult = {
  topPickFacilitatorId: string | null;
  candidates: Candidate[];
};

const NEUTRAL_SCORE = 0.5;

type AgeBucket = { min: number; max: number; score: number };

function resolveAgeScore(rawBuckets: unknown, studentAge: number): number {
  if (!Array.isArray(rawBuckets) || rawBuckets.length === 0) return NEUTRAL_SCORE;
  const buckets = rawBuckets as AgeBucket[];
  const matched = buckets.find(
    (b) =>
      typeof b?.min === 'number' &&
      typeof b?.max === 'number' &&
      typeof b?.score === 'number' &&
      studentAge >= b.min &&
      studentAge <= b.max,
  );
  return matched ? matched.score : NEUTRAL_SCORE;
}

function resolveLevelScore(rawLevels: unknown, level: Level): number {
  if (!rawLevels || typeof rawLevels !== 'object') return NEUTRAL_SCORE;
  const levels = rawLevels as Record<string, unknown>;
  const v = levels[level];
  return typeof v === 'number' ? v : NEUTRAL_SCORE;
}

function speaksAny(facilitatorLangs: string[], requestedLangs: string[]): boolean {
  // Empty teacher languages = "we don't know what they speak" — treated as polyglot.
  if (facilitatorLangs.length === 0) return true;
  return requestedLangs.some((l) => facilitatorLangs.includes(l));
}

export class RecommenderService {
  async recommend(input: RecommenderInput): Promise<RecommenderResult> {
    // Hard filter: facilitator must offer the service, be bookable,
    // and (optionally) be at the requested location.
    const facilitators = await prisma.facilitator.findMany({
      where: {
        isBookable: true,
        services: { some: { id: input.serviceId } },
        ...(input.locationId
          ? { locations: { some: { id: input.locationId } } }
          : {}),
      },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        bio: true,
        profilePictureUrl: true,
        ageScores: true,
        levelScores: true,
        languages: true,
        priorityWeight: true,
      },
    });

    const scored: Candidate[] = facilitators.map((f) => {
      const ageScore = resolveAgeScore(f.ageScores, input.studentAge);
      const levelScore = resolveLevelScore(f.levelScores, input.level);
      const priorityWeight = f.priorityWeight ?? 1.0;
      const speaksRequestedLanguage = speaksAny(f.languages, input.languages);

      // Multiplicative scoring — explicit 0 in any factor zeroes the candidate
      // out (exclusion). Widget weights tilt the relative importance of each
      // axis; defaulted to 1.0 in widget config.
      const score =
        ageScore * input.weights.ageMatch *
        (levelScore * input.weights.levelMatch) *
        (priorityWeight * input.weights.priorityWeightMultiplier);

      return {
        facilitatorId: f.id,
        score,
        breakdown: { ageScore, levelScore, priorityWeight },
        speaksRequestedLanguage,
        publicProfile: {
          firstname: f.firstname,
          lastname: f.lastname,
          bio: f.bio,
          profilePictureUrl: f.profilePictureUrl,
        },
      };
    });

    // Drop excluded (score = 0).
    const eligible = scored.filter((c) => c.score > 0);

    // Two-tier sort: speakers first, non-speakers at bottom (with red flag).
    const speakers = eligible
      .filter((c) => c.speaksRequestedLanguage)
      .sort((a, b) => b.score - a.score);
    const nonSpeakers = eligible
      .filter((c) => !c.speaksRequestedLanguage)
      .sort((a, b) => b.score - a.score);

    const candidates = input.acceptNonNativeSpeaker
      ? [...speakers, ...nonSpeakers]
      : speakers;

    return {
      topPickFacilitatorId: candidates[0]?.facilitatorId ?? null,
      candidates,
    };
  }
}

export interface DecisionMakerProfileInput {
  id: string;
  capabilityName: string;
  title: string;
  priority: number;
  seniorities: string[];
  positiveTerms: string[];
  negativeTerms: string[];
}

export interface DecisionMakerCandidateInput {
  personId: string;
  personRoleId: string;
  fullName: string;
  normalizedName: string;
  personConfidence: number;
  title: string;
  normalizedTitle: string;
  seniority: string | null;
  departments: string[];
  roleConfidence: number;
  isCurrent: boolean;
  reviewUrl: string | null;
}

export interface RankedDecisionMaker {
  personId: string;
  personRoleId: string;
  decisionMakerProfileId: string;
  fullName: string;
  title: string;
  score: number;
  components: DecisionMakerScoreComponents;
  reasons: string[];
  profilePriority: number;
  reviewUrl: string | null;
}

export interface DecisionMakerScoreComponents {
  capabilityRelevance: number;
  departmentOwnership: number;
  authority: number;
  seniority: number;
  companySizeFit: number;
  currentRoleConfidence: number;
  sourceConfidence: number;
}

const STOP_WORDS = new Set(["and", "of", "the", "to", "for", "&"]);

export function rankDecisionMakers(
  candidates: DecisionMakerCandidateInput[],
  profiles: DecisionMakerProfileInput[],
): RankedDecisionMaker[] {
  const ranked = candidates
    .filter((candidate) => candidate.isCurrent)
    .flatMap((candidate) => {
      const profileMatches = profiles
        .map((profile) => rankAgainstProfile(candidate, profile))
        .filter((match): match is RankedDecisionMaker => match !== null)
        .toSorted(compareRanked);
      return profileMatches.slice(0, 1);
    })
    .toSorted(compareRanked);

  const uniquePeople = new Map<string, RankedDecisionMaker>();
  for (const candidate of ranked) {
    const identity = normalize(candidate.fullName);
    if (!uniquePeople.has(identity)) {
      uniquePeople.set(identity, candidate);
    }
  }
  return [...uniquePeople.values()];
}

function rankAgainstProfile(
  candidate: DecisionMakerCandidateInput,
  profile: DecisionMakerProfileInput,
): RankedDecisionMaker | null {
  const candidateTitle = normalize(candidate.normalizedTitle || candidate.title);
  const profileTitle = normalize(profile.title);
  const profileTokens = tokens(profileTitle);
  const matchingTokens = profileTokens.filter((token) =>
    candidateTitle.includes(token),
  );
  const titleCoverage =
    profileTokens.length === 0 ? 0 : matchingTokens.length / profileTokens.length;
  const exactTitle = candidateTitle === profileTitle;
  const haystack = normalize(
    [candidate.title, candidate.seniority, ...candidate.departments].join(" "),
  );
  const positiveMatches = matchingTerms(haystack, profile.positiveTerms);
  const negativeMatches = matchingTerms(haystack, profile.negativeTerms);
  const departmentHaystack = normalize(candidate.departments.join(" "));
  const departmentTerms = [
    ...tokens(profile.title),
    ...profile.positiveTerms.flatMap((term) => tokens(term)),
    ...tokens(profile.capabilityName),
  ];
  const departmentMatches = [
    ...new Set(
      departmentTerms.filter(
        (term) => term.length > 1 && departmentHaystack.includes(term),
      ),
    ),
  ].toSorted();
  const seniorityMatch = profile.seniorities.some(
    (seniority) => normalizeSeniority(seniority) === normalizeSeniority(candidate.seniority),
  );

  if (
    !exactTitle &&
    matchingTokens.length === 0 &&
    positiveMatches.length === 0 &&
    departmentMatches.length === 0 &&
    !seniorityMatch
  ) {
    return null;
  }

  const components: DecisionMakerScoreComponents = {
    capabilityRelevance: Math.max(
      0,
      Math.min(
        35,
        (exactTitle
          ? Math.max(10, 42 - Math.min(profile.priority, 10) * 7)
          : Math.round(titleCoverage * 25) +
            Math.min(positiveMatches.length * 5, 10)) -
          Math.min(negativeMatches.length * 10, 20),
      ),
    ),
    departmentOwnership: Math.min(departmentMatches.length * 10, 20),
    authority: authorityScore(candidate.seniority, candidate.title),
    seniority: seniorityMatch ? 10 : 0,
    companySizeFit: 0,
    currentRoleConfidence: candidate.isCurrent
      ? Math.round(clampConfidence(candidate.roleConfidence) * 5)
      : 0,
    sourceConfidence: Math.round(clampConfidence(candidate.personConfidence) * 5),
  };
  const score = Object.values(components).reduce(
    (total, component) => total + component,
    0,
  );

  const reasons = [
    exactTitle
      ? `Exact configured role match: ${profile.title}`
      : `Configured role overlap: ${matchingTokens.join(", ") || "none"}`,
    ...(seniorityMatch
      ? [`Configured seniority match: ${candidate.seniority}`]
      : []),
    ...(positiveMatches.length > 0
      ? [`Positive role terms: ${positiveMatches.join(", ")}`]
      : []),
    ...(negativeMatches.length > 0
      ? [`Negative role terms: ${negativeMatches.join(", ")}`]
      : []),
    ...(departmentMatches.length > 0
      ? [`Department ownership terms: ${departmentMatches.join(", ")}`]
      : []),
    `Configured role priority: ${profile.priority}`,
    "Company-size fit: unavailable, safely scored 0/5",
    `Current-role confidence: ${components.currentRoleConfidence}/5`,
    `Source confidence: ${components.sourceConfidence}/5`,
  ];

  return {
    personId: candidate.personId,
    personRoleId: candidate.personRoleId,
    decisionMakerProfileId: profile.id,
    fullName: candidate.fullName,
    title: candidate.title,
    score,
    components,
    reasons,
    profilePriority: profile.priority,
    reviewUrl: candidate.reviewUrl,
  };
}

function compareRanked(
  left: RankedDecisionMaker,
  right: RankedDecisionMaker,
): number {
  return (
    right.score - left.score ||
    left.profilePriority - right.profilePriority ||
    left.fullName.localeCompare(right.fullName) ||
    left.personRoleId.localeCompare(right.personRoleId)
  );
}

function matchingTerms(haystack: string, configuredTerms: string[]): string[] {
  return [
    ...new Set(
      configuredTerms
        .map(normalize)
        .filter((term) => term.length > 0 && haystack.includes(term)),
    ),
  ].toSorted();
}

function tokens(value: string): string[] {
  return [
    ...new Set(
      normalize(value)
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
    ),
  ];
}

function normalize(value: string | null): string {
  return (value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

function normalizeSeniority(value: string | null): string {
  const normalized = normalize(value).replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    c_level: "c_suite",
    chief: "c_suite",
    vice_president: "vp",
  };
  return aliases[normalized] ?? normalized;
}

function authorityScore(seniority: string | null, title: string): number {
  const normalizedSeniority = normalizeSeniority(seniority);
  if (["owner", "founder", "partner", "c_suite"].includes(normalizedSeniority)) {
    return 20;
  }
  if (normalizedSeniority === "vp") return 18;
  if (["head", "director"].includes(normalizedSeniority)) return 16;
  if (normalizedSeniority === "manager") return 12;
  if (normalizedSeniority === "senior") return 6;

  const normalizedTitle = normalize(title);
  if (/\b(chief|ceo|coo|cto|cio|president|owner|founder)\b/.test(normalizedTitle)) {
    return 20;
  }
  if (/\b(vice president|vp)\b/.test(normalizedTitle)) return 18;
  if (/\b(head|director)\b/.test(normalizedTitle)) return 16;
  if (/\bmanager\b/.test(normalizedTitle)) return 12;
  return 0;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

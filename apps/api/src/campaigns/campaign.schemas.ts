import { z } from "zod";

const uuid = z.string().uuid();
const idList = z
  .array(uuid)
  .min(1)
  .refine((values) => new Set(values).size === values.length, {
    message: "IDs must be unique",
  });
const locationList = z
  .array(z.string().trim().min(1).max(120))
  .default([])
  .refine(
    (values) =>
      new Set(values.map((value) => value.toLowerCase())).size ===
      values.length,
    { message: "Locations must be unique" },
  );
const sequenceStepSchema = z.strictObject({
  stepNumber: z.number().int().positive(),
  delayDays: z.number().int().nonnegative(),
});

const campaignFields = {
  name: z.string().trim().min(1).max(160),
  sectorId: uuid,
  capabilityIds: idList,
  deliverableIds: idList,
  targetClientProfileIds: idList,
  countries: locationList.pipe(z.array(z.string()).min(1)),
  states: locationList.optional(),
  cities: locationList.optional(),
  minimumEmployees: z.number().int().nonnegative().nullable().optional(),
  maximumEmployees: z.number().int().nonnegative().nullable().optional(),
  researchDepth: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  targetLeadCount: z.number().int().positive().max(10_000),
  minimumScore: z.number().int().min(0).max(100),
  automationMode: z.literal("MANUAL_REVIEW").default("MANUAL_REVIEW"),
  dailyEmailLimit: z.number().int().positive().max(10_000),
  sequence: z.array(sequenceStepSchema).min(1).max(20),
};

export const createCampaignSchema = z
  .strictObject(campaignFields)
  .superRefine(validateCampaignShape);
export const updateCampaignSchema = z
  .strictObject(campaignFields)
  .partial()
  .superRefine(validateCampaignShape);
export const campaignIdSchema = uuid;

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;

function validateCampaignShape(
  input: {
    minimumEmployees?: number | null;
    maximumEmployees?: number | null;
    sequence?: Array<{ stepNumber: number; delayDays: number }>;
  },
  context: z.RefinementCtx,
): void {
  if (
    input.minimumEmployees != null &&
    input.maximumEmployees != null &&
    input.minimumEmployees > input.maximumEmployees
  ) {
    context.addIssue({
      code: "custom",
      path: ["minimumEmployees"],
      message: "minimumEmployees must not exceed maximumEmployees",
    });
  }

  if (!input.sequence) return;
  const ordered = [...input.sequence].sort(
    (left, right) => left.stepNumber - right.stepNumber,
  );
  if (ordered.some((step, index) => step.stepNumber !== index + 1)) {
    context.addIssue({
      code: "custom",
      path: ["sequence"],
      message: "Sequence steps must be unique and consecutive from 1",
    });
  }
  if (ordered[0]?.delayDays !== 0) {
    context.addIssue({
      code: "custom",
      path: ["sequence", 0, "delayDays"],
      message: "The first sequence step must have zero delay",
    });
  }
}

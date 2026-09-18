import { z } from "zod";

const name = z.string().trim().min(1).max(160);
const slug = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const text = z.string().trim().min(1);
const stringList = z.array(z.string().trim().min(1)).default([]);
const jsonValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
const jsonObject = z.record(z.string(), jsonValue);

export const uuidSchema = z.string().uuid();

export const createSectorSchema = z.strictObject({
  name,
  slug: slug.optional(),
  description: text.nullable().optional(),
  terminology: stringList.optional(),
  geographies: stringList.optional(),
  negativeTerms: stringList.optional(),
  researchRules: jsonObject.nullable().optional(),
  isActive: z.boolean().optional(),
});
export const updateSectorSchema = createSectorSchema.partial();

export const createCapabilitySchema = z.strictObject({
  sectorId: uuidSchema,
  name,
  slug: slug.optional(),
  description: text.nullable().optional(),
  businessProblems: stringList.optional(),
  businessValue: text.nullable().optional(),
  searchGuidance: jsonObject.nullable().optional(),
  researchGuidance: jsonObject.nullable().optional(),
  isActive: z.boolean().optional(),
});
export const updateCapabilitySchema = createCapabilitySchema.partial();

export const createDeliverableSchema = z.strictObject({
  capabilityId: uuidSchema,
  name,
  slug: slug.optional(),
  description: text.nullable().optional(),
  isActive: z.boolean().optional(),
});
export const updateDeliverableSchema = createDeliverableSchema.partial();

const targetProfileFields = {
  capabilityId: uuidSchema,
  name,
  slug: slug.optional(),
  companyCharacteristics: jsonObject.nullable().optional(),
  minimumEmployees: z.number().int().nonnegative().nullable().optional(),
  maximumEmployees: z.number().int().nonnegative().nullable().optional(),
  geographies: stringList.optional(),
  positiveTerms: stringList.optional(),
  negativeTerms: stringList.optional(),
  typicalBusinessModel: text.nullable().optional(),
  outsourcingCharacteristics: text.nullable().optional(),
  isActive: z.boolean().optional(),
};
const validEmployeeRange = ({
  minimumEmployees,
  maximumEmployees,
}: {
  minimumEmployees?: number | null;
  maximumEmployees?: number | null;
}) =>
  minimumEmployees == null ||
  maximumEmployees == null ||
  minimumEmployees <= maximumEmployees;
export const createTargetProfileSchema = z
  .strictObject(targetProfileFields)
  .refine(validEmployeeRange, {
    message: "minimumEmployees must not exceed maximumEmployees",
  });
export const updateTargetProfileSchema = z
  .strictObject(targetProfileFields)
  .partial()
  .refine(validEmployeeRange, {
    message: "minimumEmployees must not exceed maximumEmployees",
  });

export const createDecisionMakerSchema = z.strictObject({
  capabilityId: uuidSchema,
  title: name,
  priority: z.number().int().positive(),
  seniorities: stringList.optional(),
  positiveTerms: stringList.optional(),
  negativeTerms: stringList.optional(),
  isActive: z.boolean().optional(),
});
export const updateDecisionMakerSchema = createDecisionMakerSchema.partial();

export type CreateSectorInput = z.infer<typeof createSectorSchema>;
export type UpdateSectorInput = z.infer<typeof updateSectorSchema>;
export type CreateCapabilityInput = z.infer<typeof createCapabilitySchema>;
export type UpdateCapabilityInput = z.infer<typeof updateCapabilitySchema>;
export type CreateDeliverableInput = z.infer<typeof createDeliverableSchema>;
export type UpdateDeliverableInput = z.infer<typeof updateDeliverableSchema>;
export type CreateTargetProfileInput = z.infer<
  typeof createTargetProfileSchema
>;
export type UpdateTargetProfileInput = z.infer<
  typeof updateTargetProfileSchema
>;
export type CreateDecisionMakerInput = z.infer<
  typeof createDecisionMakerSchema
>;
export type UpdateDecisionMakerInput = z.infer<
  typeof updateDecisionMakerSchema
>;

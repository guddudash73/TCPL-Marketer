import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@tcpl-marketer/database";

import { AuditService } from "../audit/audit.service.js";
import { DatabaseService } from "../database/database.service.js";
import type {
  CreateCapabilityInput,
  CreateDecisionMakerInput,
  CreateDeliverableInput,
  CreateSectorInput,
  CreateTargetProfileInput,
  UpdateCapabilityInput,
  UpdateDecisionMakerInput,
  UpdateDeliverableInput,
  UpdateSectorInput,
  UpdateTargetProfileInput,
} from "./configuration.schemas.js";

@Injectable()
export class ConfigurationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async listSectors(): Promise<unknown> {
    return await this.database.client.sector.findMany({
      include: {
        capabilities: {
          include: {
            deliverables: true,
            targetProfiles: true,
            decisionMakers: true,
          },
          orderBy: { name: "asc" },
        },
      },
      orderBy: { name: "asc" },
    });
  }

  async getSector(id: string) {
    const sector = await this.database.client.sector.findUnique({
      where: { id },
      include: {
        capabilities: {
          include: {
            deliverables: true,
            targetProfiles: true,
            decisionMakers: true,
          },
          orderBy: { name: "asc" },
        },
      },
    });
    return this.requireRecord(sector, "Sector", id);
  }

  async createSector(input: CreateSectorInput, actorUserId: string) {
    return this.withUniqueConflict("Sector slug already exists", async () => {
      const data: Prisma.SectorUncheckedCreateInput = {
        ...input,
        slug: input.slug ?? slugify(input.name),
        researchRules: jsonInput(input.researchRules),
      };
      const sector = await this.audit.withAudit(
        (transaction) => transaction.sector.create({
        data,
      }),
        (changed) => ({ action: "configuration.sector.created", resourceId: changed.id, actorUserId }),
      );
      return sector;
    });
  }

  async updateSector(
    id: string,
    input: UpdateSectorInput,
    actorUserId: string,
  ) {
    await this.ensureSector(id);
    return this.withUniqueConflict("Sector slug already exists", async () => {
      const data: Prisma.SectorUncheckedUpdateInput = {
        ...input,
        researchRules: jsonInput(input.researchRules),
      };
      const sector = await this.audit.withAudit(
        (transaction) => transaction.sector.update({
        where: { id },
        data,
      }),
        (changed) => ({ action: "configuration.sector.updated", resourceId: changed.id, actorUserId }),
      );
      return sector;
    });
  }

  async deleteSector(id: string, actorUserId: string) {
    await this.ensureSector(id);
    const sector = await this.audit.withAudit(
        (transaction) => transaction.sector.delete({ where: { id } }),
        (changed) => ({ action: "configuration.sector.deleted", resourceId: changed.id, actorUserId }),
      );
    return sector;
  }

  async listCapabilities(): Promise<unknown> {
    return await this.database.client.serviceCapability.findMany({
      include: {
        sector: true,
        deliverables: true,
        targetProfiles: true,
        decisionMakers: true,
      },
      orderBy: { name: "asc" },
    });
  }

  async getCapability(id: string) {
    const capability = await this.database.client.serviceCapability.findUnique({
      where: { id },
      include: {
        sector: true,
        deliverables: true,
        targetProfiles: true,
        decisionMakers: true,
      },
    });
    return this.requireRecord(capability, "Capability", id);
  }

  async createCapability(input: CreateCapabilityInput, actorUserId: string) {
    await this.ensureSector(input.sectorId);
    return this.withUniqueConflict(
      "Capability slug already exists in this sector",
      async () => {
        const data: Prisma.ServiceCapabilityUncheckedCreateInput = {
          ...input,
          slug: input.slug ?? slugify(input.name),
          searchGuidance: jsonInput(input.searchGuidance),
          researchGuidance: jsonInput(input.researchGuidance),
        };
        const capability = await this.audit.withAudit(
        (transaction) => transaction.serviceCapability.create({
          data,
        }),
        (changed) => ({ action: "configuration.capability.created", resourceId: changed.id, actorUserId }),
      );
        return capability;
      },
    );
  }

  async updateCapability(
    id: string,
    input: UpdateCapabilityInput,
    actorUserId: string,
  ) {
    await this.ensureCapability(id);
    if (input.sectorId) await this.ensureSector(input.sectorId);
    return this.withUniqueConflict(
      "Capability slug already exists in this sector",
      async () => {
        const data: Prisma.ServiceCapabilityUncheckedUpdateInput = {
          ...input,
          searchGuidance: jsonInput(input.searchGuidance),
          researchGuidance: jsonInput(input.researchGuidance),
        };
        const capability = await this.audit.withAudit(
        (transaction) => transaction.serviceCapability.update({
          where: { id },
          data,
        }),
        (changed) => ({ action: "configuration.capability.updated", resourceId: changed.id, actorUserId }),
      );
        return capability;
      },
    );
  }

  async deleteCapability(id: string, actorUserId: string) {
    await this.ensureCapability(id);
    const capability = await this.audit.withAudit(
        (transaction) => transaction.serviceCapability.delete({
      where: { id },
    }),
        (changed) => ({ action: "configuration.capability.deleted", resourceId: changed.id, actorUserId }),
      );
    return capability;
  }

  async listDeliverables(): Promise<unknown> {
    return await this.database.client.capabilityDeliverable.findMany({
      include: { capability: true },
      orderBy: { name: "asc" },
    });
  }

  async getDeliverable(id: string) {
    const deliverable =
      await this.database.client.capabilityDeliverable.findUnique({
        where: { id },
        include: { capability: true },
      });
    return this.requireRecord(deliverable, "Deliverable", id);
  }

  async createDeliverable(input: CreateDeliverableInput, actorUserId: string) {
    await this.ensureCapability(input.capabilityId);
    return this.withUniqueConflict(
      "Deliverable slug already exists for this capability",
      async () => {
        const deliverable = await this.audit.withAudit(
          (transaction) =>
            transaction.capabilityDeliverable.create({
              data: { ...input, slug: input.slug ?? slugify(input.name) },
            }),
          (changed) => ({
            action: "configuration.deliverable.created",
            resourceId: changed.id,
            actorUserId,
          }),
        );
        return deliverable;
      },
    );
  }

  async updateDeliverable(
    id: string,
    input: UpdateDeliverableInput,
    actorUserId: string,
  ) {
    await this.ensureDeliverable(id);
    if (input.capabilityId) await this.ensureCapability(input.capabilityId);
    return this.withUniqueConflict(
      "Deliverable slug already exists for this capability",
      async () => {
        const deliverable = await this.audit.withAudit(
          (transaction) =>
            transaction.capabilityDeliverable.update({
              where: { id },
              data: input,
            }),
          (changed) => ({
            action: "configuration.deliverable.updated",
            resourceId: changed.id,
            actorUserId,
          }),
        );
        return deliverable;
      },
    );
  }

  async deleteDeliverable(id: string, actorUserId: string) {
    await this.ensureDeliverable(id);
    const deliverable = await this.audit.withAudit(
        (transaction) => transaction.capabilityDeliverable.delete(
      { where: { id } },
    ),
        (changed) => ({ action: "configuration.deliverable.deleted", resourceId: changed.id, actorUserId }),
      );
    return deliverable;
  }

  async listTargetProfiles(): Promise<unknown> {
    return await this.database.client.targetClientProfile.findMany({
      include: { capability: true },
      orderBy: { name: "asc" },
    });
  }

  async getTargetProfile(id: string) {
    const profile = await this.database.client.targetClientProfile.findUnique({
      where: { id },
      include: { capability: true },
    });
    return this.requireRecord(profile, "Target-client profile", id);
  }

  async createTargetProfile(
    input: CreateTargetProfileInput,
    actorUserId: string,
  ) {
    await this.ensureCapability(input.capabilityId);
    return this.withUniqueConflict(
      "Target-client profile slug already exists for this capability",
      async () => {
        const data: Prisma.TargetClientProfileUncheckedCreateInput = {
          ...input,
          slug: input.slug ?? slugify(input.name),
          companyCharacteristics: jsonInput(input.companyCharacteristics),
        };
        const profile = await this.audit.withAudit(
        (transaction) => transaction.targetClientProfile.create({
          data,
        }),
        (changed) => ({ action: "configuration.target_profile.created", resourceId: changed.id, actorUserId }),
      );
        return profile;
      },
    );
  }

  async updateTargetProfile(
    id: string,
    input: UpdateTargetProfileInput,
    actorUserId: string,
  ) {
    await this.ensureTargetProfile(id);
    if (input.capabilityId) await this.ensureCapability(input.capabilityId);
    return this.withUniqueConflict(
      "Target-client profile slug already exists for this capability",
      async () => {
        const data: Prisma.TargetClientProfileUncheckedUpdateInput = {
          ...input,
          companyCharacteristics: jsonInput(input.companyCharacteristics),
        };
        const profile = await this.audit.withAudit(
        (transaction) => transaction.targetClientProfile.update({
          where: { id },
          data,
        }),
        (changed) => ({ action: "configuration.target_profile.updated", resourceId: changed.id, actorUserId }),
      );
        return profile;
      },
    );
  }

  async deleteTargetProfile(id: string, actorUserId: string) {
    await this.ensureTargetProfile(id);
    const profile = await this.audit.withAudit(
        (transaction) => transaction.targetClientProfile.delete({
      where: { id },
    }),
        (changed) => ({ action: "configuration.target_profile.deleted", resourceId: changed.id, actorUserId }),
      );
    return profile;
  }

  async listDecisionMakers(): Promise<unknown> {
    return await this.database.client.decisionMakerProfile.findMany({
      include: { capability: true },
      orderBy: [{ capabilityId: "asc" }, { priority: "asc" }],
    });
  }

  async getDecisionMaker(id: string) {
    const profile = await this.database.client.decisionMakerProfile.findUnique({
      where: { id },
      include: { capability: true },
    });
    return this.requireRecord(profile, "Decision-maker profile", id);
  }

  async createDecisionMaker(
    input: CreateDecisionMakerInput,
    actorUserId: string,
  ) {
    await this.ensureCapability(input.capabilityId);
    return this.withUniqueConflict(
      "Decision-maker title already exists for this capability",
      async () => {
        const profile = await this.audit.withAudit(
        (transaction) => transaction.decisionMakerProfile.create({
          data: input,
        }),
        (changed) => ({ action: "configuration.decision_maker.created", resourceId: changed.id, actorUserId }),
      );
        return profile;
      },
    );
  }

  async updateDecisionMaker(
    id: string,
    input: UpdateDecisionMakerInput,
    actorUserId: string,
  ) {
    await this.ensureDecisionMaker(id);
    if (input.capabilityId) await this.ensureCapability(input.capabilityId);
    return this.withUniqueConflict(
      "Decision-maker title already exists for this capability",
      async () => {
        const profile = await this.audit.withAudit(
        (transaction) => transaction.decisionMakerProfile.update({
          where: { id },
          data: input,
        }),
        (changed) => ({ action: "configuration.decision_maker.updated", resourceId: changed.id, actorUserId }),
      );
        return profile;
      },
    );
  }

  async deleteDecisionMaker(id: string, actorUserId: string) {
    await this.ensureDecisionMaker(id);
    const profile = await this.audit.withAudit(
        (transaction) => transaction.decisionMakerProfile.delete({
      where: { id },
    }),
        (changed) => ({ action: "configuration.decision_maker.deleted", resourceId: changed.id, actorUserId }),
      );
    return profile;
  }

  private async ensureSector(id: string): Promise<void> {
    this.requireRecord(
      await this.database.client.sector.findUnique({
        where: { id },
        select: { id: true },
      }),
      "Sector",
      id,
    );
  }

  private async ensureCapability(id: string): Promise<void> {
    this.requireRecord(
      await this.database.client.serviceCapability.findUnique({
        where: { id },
        select: { id: true },
      }),
      "Capability",
      id,
    );
  }

  private async ensureDeliverable(id: string): Promise<void> {
    this.requireRecord(
      await this.database.client.capabilityDeliverable.findUnique({
        where: { id },
        select: { id: true },
      }),
      "Deliverable",
      id,
    );
  }

  private async ensureTargetProfile(id: string): Promise<void> {
    this.requireRecord(
      await this.database.client.targetClientProfile.findUnique({
        where: { id },
        select: { id: true },
      }),
      "Target-client profile",
      id,
    );
  }

  private async ensureDecisionMaker(id: string): Promise<void> {
    this.requireRecord(
      await this.database.client.decisionMakerProfile.findUnique({
        where: { id },
        select: { id: true },
      }),
      "Decision-maker profile",
      id,
    );
  }

  private requireRecord<T>(record: T | null, resource: string, id: string): T {
    if (!record) throw new NotFoundException(`${resource} ${id} was not found`);
    return record;
  }

  private async withUniqueConflict<T>(
    message: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (hasPrismaCode(error, "P2002")) throw new ConflictException(message);
      throw error;
    }
  }
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function slugify(value: string): string {
  const result = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!result) throw new ConflictException("Name cannot produce a valid slug");
  return result;
}

function jsonInput(
  value:
    | Record<string, string | number | boolean | string[]>
    | null
    | undefined,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  return value === null ? Prisma.JsonNull : value;
}

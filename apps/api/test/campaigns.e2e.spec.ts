import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { createPrismaClient } from '@tcpl-marketer/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PasswordHasher } from '../src/auth/password-hasher.js';
import { createApp } from '../src/bootstrap.js';

const managerEmail = 'd009a-manager@example.test';
const memberEmail = 'd009a-member@example.test';
const password = 'D009a-Test-Password!2026';
const database = createPrismaClient();
type TestAgent = ReturnType<typeof request.agent>;

describe('campaign CRUD', () => {
  let app: INestApplication | undefined;
  let manager: TestAgent;
  let member: TestAgent;
  let campaignId: string | undefined;
  let testUserIds: string[] = [];
  let campaignInput: Record<string, unknown>;

  beforeAll(async () => {
    await database.user.deleteMany({ where: { email: { in: [managerEmail, memberEmail] } } });
    const passwordHash = await new PasswordHasher().hash(password);
    const managerRole = await database.role.upsert({
      where: { name: 'MANAGER' },
      create: { name: 'MANAGER', description: 'Campaign management' },
      update: {},
    });
    const managerUser = await database.user.create({
      data: {
        email: managerEmail,
        displayName: 'D009a Manager',
        passwordHash,
        roles: { create: { roleId: managerRole.id } },
      },
    });
    const memberUser = await database.user.create({
      data: { email: memberEmail, displayName: 'D009a Member', passwordHash },
    });
    testUserIds = [managerUser.id, memberUser.id];

    const lidar = await database.sector.findUnique({
      where: { slug: 'lidar' },
      include: { capabilities: { include: { deliverables: true, targetProfiles: true } } },
    });
    if (!lidar?.capabilities[0]?.deliverables[0] || !lidar.capabilities[0].targetProfiles[0]) {
      throw new Error('Seeded LiDAR campaign configuration is required');
    }
    const capability = lidar.capabilities[0];
    campaignInput = {
      name: 'LiDAR USA Manual Review',
      sectorId: lidar.id,
      capabilityIds: [capability.id],
      deliverableIds: [capability.deliverables[0].id],
      targetClientProfileIds: [capability.targetProfiles[0].id],
      countries: ['United States'],
      states: [],
      cities: [],
      minimumEmployees: 10,
      maximumEmployees: 500,
      researchDepth: 'STANDARD',
      targetLeadCount: 100,
      minimumScore: 70,
      automationMode: 'MANUAL_REVIEW',
      dailyEmailLimit: 25,
      sequence: [
        { stepNumber: 1, delayDays: 0 },
        { stepNumber: 2, delayDays: 3 },
      ],
    };

    app = await createApp();
    await app.init();
    manager = request.agent(app.getHttpServer());
    member = request.agent(app.getHttpServer());
    await manager.post('/auth/login').send({ email: managerEmail, password }).expect(200);
    await member.post('/auth/login').send({ email: memberEmail, password }).expect(200);
  });

  afterAll(async () => {
    try {
      if (campaignId) await database.campaign.deleteMany({ where: { id: campaignId } });
      if (testUserIds.length > 0) {
        await database.auditLog.deleteMany({ where: { actorUserId: { in: testUserIds } } });
        await database.user.deleteMany({ where: { id: { in: testUserIds } } });
      }
      if (app) await app.close();
    } finally {
      await database.$disconnect();
    }
  });

  it('requires authentication and campaign-management authorization', async () => {
    expect(app).toBeDefined();
    await request(app!.getHttpServer()).get('/campaigns').expect(401);
    await member.get('/campaigns').expect(403);
    await member.post('/campaigns').send(campaignInput).expect(403);
  });

  it('rejects invalid configuration and sequence settings', async () => {
    await manager
      .post('/campaigns')
      .send({ ...campaignInput, capabilityIds: [randomUUID()] })
      .expect(400);
    await manager
      .post('/campaigns')
      .send({ ...campaignInput, sequence: [{ stepNumber: 2, delayDays: 1 }] })
      .expect(400);
    await manager
      .post('/campaigns')
      .send({ ...campaignInput, minimumEmployees: 500, maximumEmployees: 10 })
      .expect(400);
  });

  it('persists and updates a valid MANUAL_REVIEW draft', async () => {
    const created = await manager.post('/campaigns').send(campaignInput).expect(201);
    campaignId = created.body.id;
    expect(created.body).toMatchObject({
      name: 'LiDAR USA Manual Review',
      status: 'DRAFT',
      automationMode: 'MANUAL_REVIEW',
      countries: ['United States'],
      minimumScore: 70,
    });
    expect(created.body.capabilities).toHaveLength(1);
    expect(created.body.deliverables).toHaveLength(1);
    expect(created.body.targets).toHaveLength(1);
    expect(created.body.sequenceSteps).toHaveLength(2);

    await manager.get(`/campaigns/${campaignId}`).expect(200);
    const list = await manager.get('/campaigns').expect(200);
    expect(list.body.some((campaign: { id: string }) => campaign.id === campaignId)).toBe(true);

    const updated = await manager
      .patch(`/campaigns/${campaignId}`)
      .send({ minimumScore: 75, sequence: [{ stepNumber: 1, delayDays: 0 }] })
      .expect(200);
    expect(updated.body.minimumScore).toBe(75);
    expect(updated.body.sequenceSteps).toHaveLength(1);

    await manager.patch(`/campaigns/${campaignId}`).send({ status: 'RUNNING' }).expect(400);

    const auditCount = await database.auditLog.count({
      where: { actorUserId: testUserIds[0], action: { startsWith: 'campaign.' } },
    });
    expect(auditCount).toBe(2);
  });

  it('deletes only through the authorized CRUD endpoint', async () => {
    expect(campaignId).toBeDefined();
    await manager.delete(`/campaigns/${campaignId}`).expect(200);
    await manager.get(`/campaigns/${campaignId}`).expect(404);
    campaignId = undefined;
  });
});

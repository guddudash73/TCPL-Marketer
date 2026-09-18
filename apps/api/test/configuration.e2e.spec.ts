import type { INestApplication } from '@nestjs/common';
import { createPrismaClient } from '@tcpl-marketer/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PasswordHasher } from '../src/auth/password-hasher.js';
import { createApp } from '../src/bootstrap.js';

const adminEmail = 'd008a-admin@example.test';
const memberEmail = 'd008a-member@example.test';
const password = 'D008a-Test-Password!2026';
const database = createPrismaClient();
type TestAgent = ReturnType<typeof request.agent>;

describe('business configuration CRUD', () => {
  let app: INestApplication | undefined;
  let admin: TestAgent;
  let member: TestAgent;
  let testSectorId: string | undefined;
  let testUserIds: string[] = [];

  beforeAll(async () => {
    await database.user.deleteMany({ where: { email: { in: [adminEmail, memberEmail] } } });
    const passwordHash = await new PasswordHasher().hash(password);
    const adminRole = await database.role.upsert({
      where: { name: 'ADMIN' },
      create: { name: 'ADMIN', description: 'Full platform administration' },
      update: {},
    });
    const managerRole = await database.role.upsert({
      where: { name: 'MANAGER' },
      create: { name: 'MANAGER', description: 'Campaign management' },
      update: {},
    });
    const adminUser = await database.user.create({
      data: {
        email: adminEmail,
        displayName: 'D008a Admin',
        passwordHash,
        roles: { create: { roleId: adminRole.id } },
      },
    });
    const memberUser = await database.user.create({
      data: {
        email: memberEmail,
        displayName: 'D009b Manager',
        passwordHash,
        roles: { create: { roleId: managerRole.id } },
      },
    });
    testUserIds = [adminUser.id, memberUser.id];

    app = await createApp();
    await app.init();
    admin = request.agent(app.getHttpServer());
    member = request.agent(app.getHttpServer());
    await admin.post('/auth/login').send({ email: adminEmail, password }).expect(200);
    await member.post('/auth/login').send({ email: memberEmail, password }).expect(200);
  });

  afterAll(async () => {
    try {
      if (testSectorId) {
        await database.sector.deleteMany({ where: { id: testSectorId } });
      }
      if (testUserIds.length > 0) {
        await database.auditLog.deleteMany({ where: { actorUserId: { in: testUserIds } } });
        await database.user.deleteMany({ where: { id: { in: testUserIds } } });
      }
      if (app) await app.close();
    } finally {
      await database.$disconnect();
    }
  });

  it('persists the seeded LiDAR configuration', async () => {
    const response = await admin.get('/sectors').expect(200);
    const lidar = response.body.find((sector: { slug: string }) => sector.slug === 'lidar');

    expect(lidar).toMatchObject({ name: 'LiDAR', slug: 'lidar', isActive: true });
    expect(lidar.capabilities[0]).toMatchObject({
      name: 'Point Cloud Processing',
      slug: 'point-cloud-processing',
    });
    expect(lidar.capabilities[0].deliverables).toHaveLength(5);
    expect(lidar.capabilities[0].targetProfiles[0].name).toBe('Airborne LiDAR Survey Company');
    expect(lidar.capabilities[0].decisionMakers).toHaveLength(6);
  });

  it('allows MANAGER read-only configuration access but preserves ADMIN-only mutations', async () => {
    expect(app).toBeDefined();
    await request(app!.getHttpServer()).get('/sectors').expect(401);
    await member.get('/sectors').expect(200);
    await member.get('/capabilities').expect(200);
    await member.get('/deliverables').expect(200);
    await member.get('/target-client-profiles').expect(200);
    await member.get('/decision-maker-profiles').expect(200);
    await member.post('/sectors').send({ name: 'Forbidden Sector' }).expect(403);
  });

  it('provides validated, audited CRUD for every configuration resource', async () => {
    const sector = await admin
      .post('/sectors')
      .send({ name: 'D008a Test Sector', geographies: ['United States'] })
      .expect(201);
    testSectorId = sector.body.id;
    expect(sector.body.slug).toBe('d008a-test-sector');

    await admin.get(`/sectors/${testSectorId}`).expect(200);
    await admin.patch(`/sectors/${testSectorId}`).send({ description: 'Updated sector' }).expect(200);

    const capability = await admin
      .post('/capabilities')
      .send({ sectorId: testSectorId, name: 'Test Processing' })
      .expect(201);
    await admin.get(`/capabilities/${capability.body.id}`).expect(200);
    await admin.patch(`/capabilities/${capability.body.id}`).send({ businessValue: 'Elastic production' }).expect(200);

    const deliverable = await admin
      .post('/deliverables')
      .send({ capabilityId: capability.body.id, name: 'Test Output' })
      .expect(201);
    await admin.get(`/deliverables/${deliverable.body.id}`).expect(200);
    await admin.patch(`/deliverables/${deliverable.body.id}`).send({ description: 'Updated output' }).expect(200);

    const target = await admin
      .post('/target-client-profiles')
      .send({
        capabilityId: capability.body.id,
        name: 'Test Survey Company',
        minimumEmployees: 10,
        maximumEmployees: 500,
      })
      .expect(201);
    await admin.get(`/target-client-profiles/${target.body.id}`).expect(200);
    await admin.patch(`/target-client-profiles/${target.body.id}`).send({ positiveTerms: ['survey'] }).expect(200);

    const decisionMaker = await admin
      .post('/decision-maker-profiles')
      .send({ capabilityId: capability.body.id, title: 'Test Operations Manager', priority: 1 })
      .expect(201);
    await admin.get(`/decision-maker-profiles/${decisionMaker.body.id}`).expect(200);
    await admin.patch(`/decision-maker-profiles/${decisionMaker.body.id}`).send({ priority: 2 }).expect(200);

    await admin
      .post('/target-client-profiles')
      .send({
        capabilityId: capability.body.id,
        name: 'Invalid Size Range',
        minimumEmployees: 500,
        maximumEmployees: 10,
      })
      .expect(400);

    await admin.delete(`/decision-maker-profiles/${decisionMaker.body.id}`).expect(200);
    await admin.delete(`/target-client-profiles/${target.body.id}`).expect(200);
    await admin.delete(`/deliverables/${deliverable.body.id}`).expect(200);
    await admin.delete(`/capabilities/${capability.body.id}`).expect(200);
    await admin.delete(`/sectors/${testSectorId}`).expect(200);
    testSectorId = undefined;

    const auditCount = await database.auditLog.count({
      where: { actorUserId: testUserIds[0], action: { startsWith: 'configuration.' } },
    });
    expect(auditCount).toBeGreaterThanOrEqual(15);
  });
});

import type { INestApplication } from '@nestjs/common';
import { createPrismaClient } from '@tcpl-marketer/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PasswordHasher } from '../src/auth/password-hasher.js';
import { createApp } from '../src/bootstrap.js';

const adminEmail = 'd007-admin@example.test';
const memberEmail = 'd007-member@example.test';
const password = 'D007-Test-Password!2026';
const database = createPrismaClient();

describe('authentication and RBAC', () => {
  let app: INestApplication;
  let testUserIds: string[] = [];

  beforeAll(async () => {
    await database.user.deleteMany({ where: { email: { in: [adminEmail, memberEmail] } } });
    const passwordHash = await new PasswordHasher().hash(password);
    const adminRole = await database.role.upsert({
      where: { name: 'ADMIN' },
      create: { name: 'ADMIN', description: 'Full platform administration' },
      update: {},
    });
    const admin = await database.user.create({
      data: {
        email: adminEmail,
        displayName: 'D007 Admin',
        passwordHash,
        roles: { create: { roleId: adminRole.id } },
      },
    });
    const member = await database.user.create({
      data: { email: memberEmail, displayName: 'D007 Member', passwordHash },
    });
    testUserIds = [admin.id, member.id];
    expect(admin.id).toBeTruthy();

    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await database.auditLog.deleteMany({
      where: {
        OR: [
          { actorUserId: { in: testUserIds } },
          { resourceId: { in: [...testUserIds, adminEmail, memberEmail] } },
        ],
      },
    });
    await database.user.deleteMany({ where: { email: { in: [adminEmail, memberEmail] } } });
    await database.$disconnect();
  });

  it('logs in the admin and permits the ADMIN route', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/auth/login')
      .send({ email: adminEmail.toUpperCase(), password })
      .expect(200);

    expect(login.body.user).toMatchObject({ email: adminEmail, roles: ['ADMIN'] });
    expect(login.headers['set-cookie']?.[0]).toContain('tcpl_session=');
    expect(login.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(login.headers['set-cookie']?.[0]).toContain('SameSite=Strict');

    await agent.get('/admin/ping').expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ status: 'ok' });
      expect(body.userId).toBeTypeOf('string');
    });
  });

  it('denies an authenticated user without the ADMIN role', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.post('/auth/login').send({ email: memberEmail, password }).expect(200);
    await agent.get('/admin/ping').expect(403);
  });

  it('rejects invalid credentials without exposing password data', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: memberEmail, password: 'wrong-password' })
      .expect(401);

    const audit = await database.auditLog.findFirst({
      where: { action: 'auth.login.failed', resourceId: memberEmail },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.metadata).not.toHaveProperty('password');
  });
});

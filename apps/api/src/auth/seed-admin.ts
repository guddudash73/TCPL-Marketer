import 'reflect-metadata';

import { createPrismaClient } from '@tcpl-marketer/database';
import { z } from 'zod';

import { PasswordHasher } from './password-hasher.js';

const seedEnvironmentSchema = z.object({
  ADMIN_EMAIL: z.string().trim().toLowerCase().email().max(320),
  ADMIN_PASSWORD: z
    .string()
    .min(12)
    .max(128)
    .regex(/[a-z]/, 'must contain a lowercase letter')
    .regex(/[A-Z]/, 'must contain an uppercase letter')
    .regex(/[0-9]/, 'must contain a number')
    .regex(/[^A-Za-z0-9]/, 'must contain a symbol'),
  ADMIN_NAME: z.string().trim().min(1).max(160).default('Platform Administrator'),
  ADMIN_RESET_PASSWORD: z.enum(['true', 'false']).default('false'),
});

const environment = seedEnvironmentSchema.parse(process.env);
const database = createPrismaClient();
const passwordHasher = new PasswordHasher();

try {
  const existingUser = await database.user.findUnique({ where: { email: environment.ADMIN_EMAIL } });
  if (existingUser?.status === 'DISABLED') {
    throw new Error('Refusing to re-enable a disabled admin account');
  }

  const shouldSetPassword = !existingUser || environment.ADMIN_RESET_PASSWORD === 'true';
  const passwordHash = shouldSetPassword
    ? await passwordHasher.hash(environment.ADMIN_PASSWORD)
    : existingUser.passwordHash;
  const adminRole = await database.role.upsert({
    where: { name: 'ADMIN' },
    create: { name: 'ADMIN', description: 'Full platform administration' },
    update: { description: 'Full platform administration' },
  });
  const adminUser = await database.user.upsert({
    where: { email: environment.ADMIN_EMAIL },
    create: {
      email: environment.ADMIN_EMAIL,
      displayName: environment.ADMIN_NAME,
      passwordHash,
    },
    update: {
      displayName: environment.ADMIN_NAME,
      ...(environment.ADMIN_RESET_PASSWORD === 'true' ? { passwordHash } : {}),
    },
  });

  await database.$transaction([
    database.userRole.upsert({
      where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id } },
      create: { userId: adminUser.id, roleId: adminRole.id },
      update: {},
    }),
    database.auditLog.create({
      data: {
        actorUserId: adminUser.id,
        action: existingUser ? 'admin.seed.verified' : 'admin.seed.created',
        resourceType: 'user',
        resourceId: adminUser.id,
        metadata: { passwordChanged: shouldSetPassword },
      },
    }),
  ]);

  process.stdout.write(
    `Admin seed complete for ${environment.ADMIN_EMAIL}; password ${shouldSetPassword ? 'set' : 'unchanged'}.\n`,
  );
} finally {
  await database.$disconnect();
}

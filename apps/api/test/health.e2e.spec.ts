import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

import { createApp } from '../src/bootstrap.js';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a healthy response and forwards its correlation ID', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('x-correlation-id', 'health-check-001')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['x-correlation-id']).toBe('health-check-001');
  });
});

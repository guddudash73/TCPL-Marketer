import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { HealthModule } from './health/health.module.js';
import { pinoHttpOptions } from './logging/pino-http-options.js';

@Module({
  imports: [LoggerModule.forRoot({ pinoHttp: pinoHttpOptions }), HealthModule],
})
export class AppModule {}

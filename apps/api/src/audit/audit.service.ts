import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';

interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string;
  actorUserId?: string;
  metadata?: Record<string, boolean | number | string | null>;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.database.client.auditLog.create({
      data: {
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        actorUserId: entry.actorUserId,
        metadata: entry.metadata,
      },
    });
  }
}

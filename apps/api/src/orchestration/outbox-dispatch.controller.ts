import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { Public } from "../auth/public.decorator.js";
import { Roles } from "../auth/roles.decorator.js";
import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import {
  OutboxDispatcherService,
  type DispatchTickResult,
} from "./outbox-dispatcher.service.js";

const limitSchema = z.coerce.number().int().min(1).max(100).default(50);

function parseLimit(value: string | undefined): number {
  const parsed = limitSchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException("limit must be an integer from 1 to 100");
  }
  return parsed.data;
}

/** Called by the scheduled n8n workflow; NestJS decides what is due. */
@Controller("internal/orchestration")
@Public()
@UseGuards(ServiceAuthGuard)
export class InternalOutboxDispatchController {
  constructor(
    @Inject(OutboxDispatcherService)
    private readonly dispatcher: OutboxDispatcherService,
  ) {}

  @Post("dispatch")
  @HttpCode(200)
  dispatch(): Promise<DispatchTickResult> {
    return this.dispatcher.tick();
  }
}

/** Operator read views. Event payloads are deliberately not returned. */
@Controller("orchestration")
@Roles("ADMIN", "MANAGER")
export class OutboxOperatorController {
  constructor(
    @Inject(OutboxDispatcherService)
    private readonly dispatcher: OutboxDispatcherService,
  ) {}

  @Get("dead-letters")
  deadLetters(@Query("limit") limit?: string): Promise<unknown[]> {
    return this.dispatcher.listDeadLetters(parseLimit(limit));
  }

  @Get("in-flight")
  inFlight(@Query("limit") limit?: string): Promise<unknown[]> {
    return this.dispatcher.listInFlight(parseLimit(limit));
  }
}

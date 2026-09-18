import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";

import type { AuthenticatedRequest } from "../../auth/auth.types.js";
import { Roles } from "../../auth/roles.decorator.js";
import {
  createDeliverableSchema,
  type CreateDeliverableInput,
  updateDeliverableSchema,
  type UpdateDeliverableInput,
  uuidSchema,
} from "../configuration.schemas.js";
import { ConfigurationService } from "../configuration.service.js";

@Controller("deliverables")
export class DeliverablesController {
  constructor(
    @Inject(ConfigurationService)
    private readonly configuration: ConfigurationService,
  ) {}

  @Get()
  @Roles("ADMIN", "MANAGER")
  list() {
    return this.configuration.listDeliverables();
  }

  @Get(":id")
  @Roles("ADMIN", "MANAGER")
  get(@Param("id", { schema: uuidSchema }) id: string) {
    return this.configuration.getDeliverable(id);
  }

  @Post()
  @Roles("ADMIN")
  create(
    @Body({ schema: createDeliverableSchema }) input: CreateDeliverableInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.createDeliverable(input, request.user!.id);
  }

  @Patch(":id")
  @Roles("ADMIN")
  update(
    @Param("id", { schema: uuidSchema }) id: string,
    @Body({ schema: updateDeliverableSchema }) input: UpdateDeliverableInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.updateDeliverable(id, input, request.user!.id);
  }

  @Delete(":id")
  @Roles("ADMIN")
  delete(
    @Param("id", { schema: uuidSchema }) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.deleteDeliverable(id, request.user!.id);
  }
}

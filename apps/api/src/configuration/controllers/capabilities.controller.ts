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
  createCapabilitySchema,
  type CreateCapabilityInput,
  updateCapabilitySchema,
  type UpdateCapabilityInput,
  uuidSchema,
} from "../configuration.schemas.js";
import { ConfigurationService } from "../configuration.service.js";

@Controller("capabilities")
export class CapabilitiesController {
  constructor(
    @Inject(ConfigurationService)
    private readonly configuration: ConfigurationService,
  ) {}

  @Get()
  @Roles("ADMIN", "MANAGER")
  list() {
    return this.configuration.listCapabilities();
  }

  @Get(":id")
  @Roles("ADMIN", "MANAGER")
  get(@Param("id", { schema: uuidSchema }) id: string) {
    return this.configuration.getCapability(id);
  }

  @Post()
  @Roles("ADMIN")
  create(
    @Body({ schema: createCapabilitySchema }) input: CreateCapabilityInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.createCapability(input, request.user!.id);
  }

  @Patch(":id")
  @Roles("ADMIN")
  update(
    @Param("id", { schema: uuidSchema }) id: string,
    @Body({ schema: updateCapabilitySchema }) input: UpdateCapabilityInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.updateCapability(id, input, request.user!.id);
  }

  @Delete(":id")
  @Roles("ADMIN")
  delete(
    @Param("id", { schema: uuidSchema }) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.deleteCapability(id, request.user!.id);
  }
}

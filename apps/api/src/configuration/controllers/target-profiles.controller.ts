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
  createTargetProfileSchema,
  type CreateTargetProfileInput,
  updateTargetProfileSchema,
  type UpdateTargetProfileInput,
  uuidSchema,
} from "../configuration.schemas.js";
import { ConfigurationService } from "../configuration.service.js";

@Controller("target-client-profiles")
export class TargetProfilesController {
  constructor(
    @Inject(ConfigurationService)
    private readonly configuration: ConfigurationService,
  ) {}

  @Get()
  @Roles("ADMIN", "MANAGER")
  list() {
    return this.configuration.listTargetProfiles();
  }

  @Get(":id")
  @Roles("ADMIN", "MANAGER")
  get(@Param("id", { schema: uuidSchema }) id: string) {
    return this.configuration.getTargetProfile(id);
  }

  @Post()
  @Roles("ADMIN")
  create(
    @Body({ schema: createTargetProfileSchema })
    input: CreateTargetProfileInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.createTargetProfile(input, request.user!.id);
  }

  @Patch(":id")
  @Roles("ADMIN")
  update(
    @Param("id", { schema: uuidSchema }) id: string,
    @Body({ schema: updateTargetProfileSchema })
    input: UpdateTargetProfileInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.updateTargetProfile(id, input, request.user!.id);
  }

  @Delete(":id")
  @Roles("ADMIN")
  delete(
    @Param("id", { schema: uuidSchema }) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.deleteTargetProfile(id, request.user!.id);
  }
}

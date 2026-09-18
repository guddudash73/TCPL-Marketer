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
  createSectorSchema,
  type CreateSectorInput,
  updateSectorSchema,
  type UpdateSectorInput,
  uuidSchema,
} from "../configuration.schemas.js";
import { ConfigurationService } from "../configuration.service.js";

@Controller("sectors")
export class SectorsController {
  constructor(
    @Inject(ConfigurationService)
    private readonly configuration: ConfigurationService,
  ) {}

  @Get()
  @Roles("ADMIN", "MANAGER")
  list() {
    return this.configuration.listSectors();
  }

  @Get(":id")
  @Roles("ADMIN", "MANAGER")
  get(@Param("id", { schema: uuidSchema }) id: string) {
    return this.configuration.getSector(id);
  }

  @Post()
  @Roles("ADMIN")
  create(
    @Body({ schema: createSectorSchema }) input: CreateSectorInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.createSector(input, request.user!.id);
  }

  @Patch(":id")
  @Roles("ADMIN")
  update(
    @Param("id", { schema: uuidSchema }) id: string,
    @Body({ schema: updateSectorSchema }) input: UpdateSectorInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.updateSector(id, input, request.user!.id);
  }

  @Delete(":id")
  @Roles("ADMIN")
  delete(
    @Param("id", { schema: uuidSchema }) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.deleteSector(id, request.user!.id);
  }
}

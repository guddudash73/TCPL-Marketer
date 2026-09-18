import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';

import type { AuthenticatedRequest } from '../../auth/auth.types.js';
import { Roles } from '../../auth/roles.decorator.js';
import {
  createDecisionMakerSchema,
  type CreateDecisionMakerInput,
  updateDecisionMakerSchema,
  type UpdateDecisionMakerInput,
  uuidSchema,
} from '../configuration.schemas.js';
import { ConfigurationService } from '../configuration.service.js';

@Controller('decision-maker-profiles')
@Roles('ADMIN')
export class DecisionMakersController {
  constructor(@Inject(ConfigurationService) private readonly configuration: ConfigurationService) {}

  @Get()
  list() {
    return this.configuration.listDecisionMakers();
  }

  @Get(':id')
  get(@Param('id', { schema: uuidSchema }) id: string) {
    return this.configuration.getDecisionMaker(id);
  }

  @Post()
  create(@Body({ schema: createDecisionMakerSchema }) input: CreateDecisionMakerInput, @Req() request: AuthenticatedRequest) {
    return this.configuration.createDecisionMaker(input, request.user!.id);
  }

  @Patch(':id')
  update(
    @Param('id', { schema: uuidSchema }) id: string,
    @Body({ schema: updateDecisionMakerSchema }) input: UpdateDecisionMakerInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.configuration.updateDecisionMaker(id, input, request.user!.id);
  }

  @Delete(':id')
  delete(@Param('id', { schema: uuidSchema }) id: string, @Req() request: AuthenticatedRequest) {
    return this.configuration.deleteDecisionMaker(id, request.user!.id);
  }
}

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

import type { AuthenticatedRequest } from "../auth/auth.types.js";
import { Roles } from "../auth/roles.decorator.js";
import {
  campaignIdSchema,
  createCampaignSchema,
  type CreateCampaignInput,
  updateCampaignSchema,
  type UpdateCampaignInput,
} from "./campaign.schemas.js";
import { CampaignsService } from "./campaigns.service.js";

@Controller("campaigns")
@Roles("ADMIN", "MANAGER")
export class CampaignsController {
  constructor(
    @Inject(CampaignsService) private readonly campaigns: CampaignsService,
  ) {}

  @Get()
  list(): Promise<unknown> {
    return this.campaigns.list();
  }

  @Get(":id")
  get(@Param("id", { schema: campaignIdSchema }) id: string): Promise<unknown> {
    return this.campaigns.get(id);
  }

  @Post()
  create(
    @Body({ schema: createCampaignSchema }) input: CreateCampaignInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    return this.campaigns.create(input, request.user!.id);
  }

  @Patch(":id")
  update(
    @Param("id", { schema: campaignIdSchema }) id: string,
    @Body({ schema: updateCampaignSchema }) input: UpdateCampaignInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<unknown> {
    return this.campaigns.update(id, input, request.user!.id);
  }

  @Delete(":id")
  delete(
    @Param("id", { schema: campaignIdSchema }) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ id: string }> {
    return this.campaigns.delete(id, request.user!.id);
  }
}

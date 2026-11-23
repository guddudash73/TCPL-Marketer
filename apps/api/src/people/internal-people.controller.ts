import { Controller, Get, Headers, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";

import { Public } from "../auth/public.decorator.js";
import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import { DecisionMakerAssignmentService } from "./decision-maker-assignment.service.js";
import { PeopleSelectionWorkflowService } from "./people-selection-workflow.service.js";

const candidateIdSchema = z.string().uuid();

@Controller("internal/lead-candidates")
@Public()
@UseGuards(ServiceAuthGuard)
export class InternalPeopleController {
  constructor(
    @Inject(PeopleSelectionWorkflowService)
    private readonly workflow: PeopleSelectionWorkflowService,
    @Inject(DecisionMakerAssignmentService)
    private readonly assignments: DecisionMakerAssignmentService,
  ) {}

  @Post(":id/decision-makers")
  select(
    @Param("id", { schema: candidateIdSchema }) id: string,
    @Headers("x-f001-diagnostic-run-id") diagnosticRunId?: string,
    @Headers("x-f001-input-hash") inputHash?: string,
  ): Promise<unknown> {
    return this.workflow.selectDecisionMakers(id, diagnosticRunId, inputHash);
  }

  @Get(":id/decision-makers")
  latest(@Param("id", { schema: candidateIdSchema }) id: string): Promise<unknown> {
    return this.assignments.getLatest(id);
  }
}

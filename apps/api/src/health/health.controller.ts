import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";

import { Public } from "../auth/public.decorator.js";

@ApiTags("health")
@Controller("health")
export class HealthController {
  @Public()
  @Get()
  @ApiOkResponse({
    description: "Returns when the API process is accepting requests.",
  })
  getHealth(): { status: "ok" } {
    return { status: "ok" };
  }
}

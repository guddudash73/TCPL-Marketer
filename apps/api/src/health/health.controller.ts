import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOkResponse({
    description: 'Returns when the API process is accepting requests.',
  })
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

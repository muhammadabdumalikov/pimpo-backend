import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Liveness for the container HEALTHCHECK (Dockerfile). A deploy only goes
  // live once the new container answers here, and it only listens after its
  // migrations applied — so a failed migration leaves the old one serving.
  // Deliberately no database query: a DB blip must not mark it unhealthy.
  @Get('health')
  health(): {status: 'ok'} {
    return {status: 'ok'};
  }
}

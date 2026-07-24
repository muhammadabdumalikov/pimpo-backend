import {Module} from '@nestjs/common';
import {BillzController} from './billz.controller';
import {BillzService} from './billz.service';
import {BillzClientService} from './billz-client.service';
import {BillzImportService} from './billz-import.service';
import {BillzImportWorker} from './billz-import.worker';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {BranchModule} from '../branch/branch.module';

@Module({
  // BranchModule → BranchService (main/default branch for stock writes).
  // StorageService is provided globally (@Global StorageModule) for image saves.
  imports: [DatabaseModule, BusinessModule, BranchModule],
  controllers: [BillzController],
  providers: [
    BillzService,
    BillzClientService,
    BillzImportService,
    BillzImportWorker,
  ],
  exports: [BillzService, BillzClientService],
})
export class BillzModule {}

import {PartialType} from '@nestjs/swagger';
import {CreateReceiptTemplateDto} from './create-receipt-template.dto';

export class UpdateReceiptTemplateDto extends PartialType(
  CreateReceiptTemplateDto,
) {}

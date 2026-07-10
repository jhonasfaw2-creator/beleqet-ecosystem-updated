import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller'; // 👈 Added this import

@Module({
  controllers: [PaymentsController], // 👈 Added this controller registration array
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
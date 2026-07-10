import { Controller, Post, Body, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * Secure endpoint for cross-border multi-currency Stripe checkout sessions.
   * POST /api/v1/payments/intent
   */
  @Post('intent')
  @HttpCode(HttpStatus.OK)
  async createPaymentIntent(@Body() createPaymentIntentDto: CreatePaymentIntentDto) {
    if (!createPaymentIntentDto.amount || createPaymentIntentDto.amount <= 0) {
      throw new BadRequestException('Transaction amount must be greater than zero.');
    }
    return await this.paymentsService.createPaymentIntent(createPaymentIntentDto);
  }
}
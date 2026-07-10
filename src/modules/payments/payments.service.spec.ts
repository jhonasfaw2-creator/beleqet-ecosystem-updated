// Mocking the third-party stripe module completely. Hoist this mock so it's
// applied before the module under test imports it.
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => {
    return {
      paymentIntents: {
        create: jest.fn(),
      },
    };
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from './payments.service';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let mockStripeInstance: any;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'STRIPE_SECRET_KEY') return 'sk_test_mock_key';
      if (key === 'STRIPE_WEBHOOK_SECRET') return 'whsec_mock_secret';
      return null;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    mockStripeInstance = (service as any).stripe;
  });

  it('should be successfully initialized', () => {
    expect(service).toBeDefined();
  });

  describe('createPaymentIntent calculation boundaries', () => {
    const dto = { amount: 79.50, currency: 'USD', bookingId: 'bk-991' };

    it('should convert currency amount to lowest denomination units (cents)', async () => {
      mockStripeInstance.paymentIntents.create.mockResolvedValue({
        client_secret: 'pi_test_secret_abc123',
      });

      const result = await service.createPaymentIntent(dto);
      expect(result).toEqual({ clientSecret: 'pi_test_secret_abc123' });
      expect(mockStripeInstance.paymentIntents.create).toHaveBeenCalledWith({
        amount: 7950, // Flawless currency math verification
        currency: 'usd',
        metadata: { bookingId: 'bk-991' },
        automatic_payment_methods: { enabled: true },
      });
    });

    it('should reject with BadRequestException when external Stripe API breaks down', async () => {
      mockStripeInstance.paymentIntents.create.mockRejectedValue(new Error('API Timeout'));
      await expect(service.createPaymentIntent(dto)).rejects.toThrow(BadRequestException);
    });
  });
});
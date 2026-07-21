import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletService, WithdrawDto } from './wallet.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('WalletService', () => {
  let service: WalletService;
  let prisma: {
    employerWallet: { findUnique: jest.Mock; create: jest.Mock };
    freelancerWallet: { findUnique: jest.Mock; upsert: jest.Mock; update: jest.Mock };
    walletTransaction: { create: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let configValues: Record<string, string | undefined>;

  beforeEach(async () => {
    configValues = {};
    prisma = {
      employerWallet: { findUnique: jest.fn(), create: jest.fn() },
      freelancerWallet: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
      walletTransaction: { create: jest.fn(), update: jest.fn() },
      // Support both the callback and array forms used by the service.
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function' ? (arg as (p: unknown) => unknown)(prisma) : Promise.resolve(arg),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: (k: string) => configValues[k] } },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('getEmployerWallet', () => {
    it('returns an existing wallet', async () => {
      prisma.employerWallet.findUnique.mockResolvedValue({ id: 'w1' });
      await expect(service.getEmployerWallet('u1')).resolves.toMatchObject({ id: 'w1' });
      expect(prisma.employerWallet.create).not.toHaveBeenCalled();
    });

    it('lazily creates a wallet when none exists', async () => {
      prisma.employerWallet.findUnique.mockResolvedValue(null);
      prisma.employerWallet.create.mockResolvedValue({ id: 'w-new', balance: 0 });
      await expect(service.getEmployerWallet('u1')).resolves.toMatchObject({ id: 'w-new' });
      expect(prisma.employerWallet.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('convertCurrency', () => {
    it('returns the amount unchanged for identical currencies', () => {
      expect(service.convertCurrency(500, 'ETB', 'ETB')).toBe(500);
    });

    it('converts using the configured rate and rounds', () => {
      expect(service.convertCurrency(1, 'USD', 'ETB')).toBe(121); // 120.5 -> 121
    });

    it('throws for an unsupported currency pair', () => {
      expect(() => service.convertCurrency(1, 'GBP', 'ETB')).toThrow(BadRequestException);
    });
  });

  describe('withdraw', () => {
    const dto: WithdrawDto = {
      amount: 100,
      method: 'TELEBIRR',
      accountRef: '0912345678',
      currency: 'ETB',
    };

    it('throws when the wallet is missing', async () => {
      prisma.freelancerWallet.findUnique.mockResolvedValue(null);
      await expect(service.withdraw('u1', dto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects when the available balance is insufficient', async () => {
      prisma.freelancerWallet.findUnique.mockResolvedValue({
        id: 'w1',
        currency: 'ETB',
        availableBalance: 50,
      });
      await expect(service.withdraw('u1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('succeeds without gateway calls when no Chapa secret is configured', async () => {
      prisma.freelancerWallet.findUnique.mockResolvedValue({
        id: 'w1',
        currency: 'ETB',
        availableBalance: 500,
      });
      prisma.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      const fetchSpy = jest.spyOn(global, 'fetch' as never);

      const result = await service.withdraw('u1', dto);

      expect(result).toMatchObject({ success: true, amount: 100, method: 'TELEBIRR' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rolls back the balance when Chapa rejects the payout', async () => {
      configValues.CHAPA_SECRET_KEY = 'sk_test';
      prisma.freelancerWallet.findUnique.mockResolvedValue({
        id: 'w1',
        currency: 'ETB',
        availableBalance: 500,
      });
      prisma.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      global.fetch = jest
        .fn()
        .mockResolvedValue({
          json: async () => ({ status: 'failed', message: 'bad account' }),
        }) as never;

      await expect(service.withdraw('u1', dto)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      // The debit + a rollback restore transaction should both have run.
      expect(prisma.freelancerWallet.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { availableBalance: { increment: 100 } } }),
      );
    });

    it('rolls back and wraps network errors reaching Chapa', async () => {
      configValues.CHAPA_SECRET_KEY = 'sk_test';
      prisma.freelancerWallet.findUnique.mockResolvedValue({
        id: 'w1',
        currency: 'ETB',
        availableBalance: 500,
      });
      prisma.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;

      await expect(service.withdraw('u1', dto)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(prisma.freelancerWallet.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { availableBalance: { increment: 100 } } }),
      );
    });
  });
});

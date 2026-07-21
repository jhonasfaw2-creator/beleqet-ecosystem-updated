import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { FreelanceService } from './freelance.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('FreelanceService', () => {
  let service: FreelanceService;
  let prisma: {
    freelanceJob: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    bid: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    contract: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
    escrowTransaction: { findFirst: jest.Mock; update: jest.Mock };
    employerWallet: { upsert: jest.Mock };
    employerWalletTransaction: { create: jest.Mock };
    chatRoom: { create: jest.Mock };
    milestone: { create: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      freelanceJob: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      bid: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      contract: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      escrowTransaction: { findFirst: jest.fn(), update: jest.fn() },
      employerWallet: { upsert: jest.fn() },
      employerWalletTransaction: { create: jest.fn() },
      chatRoom: { create: jest.fn() },
      milestone: { create: jest.fn() },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [FreelanceService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<FreelanceService>(FreelanceService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createJob', () => {
    it('stamps the client and opens the gig', async () => {
      prisma.freelanceJob.create.mockResolvedValue({ id: 'g1' });
      await service.createJob('client1', { title: 'Gig' } as never);
      const data = prisma.freelanceJob.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ title: 'Gig', clientId: 'client1', status: 'OPEN' });
    });
  });

  describe('findJobs', () => {
    it('filters on open/funded gigs and paginates', async () => {
      prisma.freelanceJob.findMany.mockResolvedValue([{ id: 'g1' }]);
      prisma.freelanceJob.count.mockResolvedValue(10);

      const result = await service.findJobs({ q: 'react', category: 'eng', page: 1, limit: 5 });

      const where = prisma.freelanceJob.findMany.mock.calls[0][0].where;
      expect(where.status).toEqual({ in: ['OPEN', 'FUNDED'] });
      expect(where.category).toEqual({ slug: 'eng' });
      expect(where.OR).toHaveLength(2);
      expect(result).toMatchObject({ total: 10, totalPages: 2 });
    });
  });

  describe('findJobById', () => {
    it('throws when the gig is missing', async () => {
      prisma.freelanceJob.findUnique.mockResolvedValue(null);
      await expect(service.findJobById('g1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('submitBid', () => {
    it('throws when the gig is not accepting bids', async () => {
      prisma.freelanceJob.findFirst.mockResolvedValue(null);
      await expect(service.submitBid('f1', 'g1', {} as never)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a duplicate bid', async () => {
      prisma.freelanceJob.findFirst.mockResolvedValue({ id: 'g1' });
      prisma.bid.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(service.submitBid('f1', 'g1', {} as never)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('creates the bid linked to gig and freelancer', async () => {
      prisma.freelanceJob.findFirst.mockResolvedValue({ id: 'g1' });
      prisma.bid.findUnique.mockResolvedValue(null);
      prisma.bid.create.mockResolvedValue({ id: 'b1' });
      await service.submitBid('f1', 'g1', { amount: 100 } as never);
      expect(prisma.bid.create.mock.calls[0][0].data).toMatchObject({
        amount: 100,
        freelanceJobId: 'g1',
        freelancerId: 'f1',
      });
    });
  });

  describe('acceptBid', () => {
    it('throws when the bid is not on the client’s gig', async () => {
      prisma.bid.findFirst.mockResolvedValue(null);
      await expect(service.acceptBid('b1', 'client1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('accepts the bid, rejects the rest, creates a contract and chat room', async () => {
      prisma.bid.findFirst.mockResolvedValue({
        id: 'b1',
        freelanceJobId: 'g1',
        freelancerId: 'f1',
        amount: 20000,
      });
      prisma.contract.create.mockResolvedValue({ id: 'contract1' });
      prisma.escrowTransaction.findFirst.mockResolvedValue(null);

      const result = await service.acceptBid('b1', 'client1');

      expect(result).toMatchObject({ id: 'contract1' });
      expect(prisma.bid.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { status: 'ACCEPTED' },
      });
      expect(prisma.bid.updateMany).toHaveBeenCalledWith({
        where: { freelanceJobId: 'g1', id: { not: 'b1' } },
        data: { status: 'REJECTED' },
      });
      expect(prisma.freelanceJob.update).toHaveBeenCalledWith({
        where: { id: 'g1' },
        data: { status: 'IN_PROGRESS' },
      });
      expect(prisma.chatRoom.create).toHaveBeenCalledTimes(1);
    });

    it('refunds excess escrow and recomputes the platform fee when the bid is lower', async () => {
      prisma.bid.findFirst.mockResolvedValue({
        id: 'b1',
        freelanceJobId: 'g1',
        freelancerId: 'f1',
        amount: 20000,
      });
      prisma.contract.create.mockResolvedValue({ id: 'contract1' });
      prisma.escrowTransaction.findFirst.mockResolvedValue({
        id: 'e1',
        grossAmount: 30000,
      });
      prisma.employerWallet.upsert.mockResolvedValue({ id: 'ew1' });

      await service.acceptBid('b1', 'client1');

      // 30000 - 20000 = 10000 refunded
      expect(prisma.employerWallet.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { balance: { increment: 10000 } } }),
      );
      expect(prisma.employerWalletTransaction.create.mock.calls[0][0].data.amount).toBe(10000);
      // fee = round(20000 * 0.10) = 2000; net = 18000
      expect(prisma.escrowTransaction.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { grossAmount: 20000, platformFee: 2000, netAmount: 18000 },
      });
    });
  });

  describe('rejectBid', () => {
    it('throws when the bid is not on the client’s gig', async () => {
      prisma.bid.findFirst.mockResolvedValue(null);
      await expect(service.rejectBid('b1', 'client1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('marks an owned bid as rejected', async () => {
      prisma.bid.findFirst.mockResolvedValue({ id: 'b1' });
      prisma.bid.update.mockResolvedValue({ id: 'b1', status: 'REJECTED' });
      await service.rejectBid('b1', 'client1');
      expect(prisma.bid.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { status: 'REJECTED' },
      });
    });
  });

  describe('getContract', () => {
    it('throws when the contract is missing', async () => {
      prisma.contract.findUnique.mockResolvedValue(null);
      await expect(service.getContract('c1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createMilestone', () => {
    it('throws when the freelancer does not own the contract', async () => {
      prisma.contract.findFirst.mockResolvedValue(null);
      await expect(
        service.createMilestone('f1', 'c1', { deadline: '2026-07-10T00:00:00.000Z' } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('creates a milestone with a coerced deadline', async () => {
      prisma.contract.findFirst.mockResolvedValue({ id: 'c1' });
      prisma.milestone.create.mockResolvedValue({ id: 'm1' });
      await service.createMilestone('f1', 'c1', {
        title: 'Design',
        amount: 1000,
        deadline: '2026-07-10T00:00:00.000Z',
      } as never);
      const data = prisma.milestone.create.mock.calls[0][0].data;
      expect(data.contractId).toBe('c1');
      expect(data.deadline).toBeInstanceOf(Date);
    });
  });
});

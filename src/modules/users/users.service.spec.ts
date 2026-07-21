import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    company: { create: jest.Mock; findUnique: jest.Mock };
    notification: { findMany: jest.Mock; updateMany: jest.Mock };
    job: { findMany: jest.Mock };
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      company: { create: jest.fn(), findUnique: jest.fn() },
      notification: { findMany: jest.fn(), updateMany: jest.fn() },
      job: { findMany: jest.fn() },
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('findById', () => {
    it('returns the user when found', async () => {
      const user = { id: 'u1', email: 'a@b.com' };
      prisma.user.findUnique.mockResolvedValue(user);
      await expect(service.findById('u1')).resolves.toBe(user);
    });

    it('throws when the user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findById('u1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('addClientFeedback', () => {
    it('throws when the user is missing', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.addClientFeedback('u1', {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('appends to existing feedback', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', clientFeedback: [{ rating: 4 }] });
      prisma.user.update.mockResolvedValue({ id: 'u1' });

      await service.addClientFeedback('u1', { rating: 5 });

      const updateArg = prisma.user.update.mock.calls[0][0];
      expect(updateArg.data.clientFeedback).toEqual([{ rating: 4 }, { rating: 5 }]);
    });

    it('initialises feedback when the stored value is not an array', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', clientFeedback: null });
      prisma.user.update.mockResolvedValue({ id: 'u1' });

      await service.addClientFeedback('u1', { rating: 5 });

      const updateArg = prisma.user.update.mock.calls[0][0];
      expect(updateArg.data.clientFeedback).toEqual([{ rating: 5 }]);
    });
  });

  describe('verifySkill', () => {
    it('throws when the user is missing', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.verifySkill('u1', true)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('persists the verification status', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      prisma.user.update.mockResolvedValue({ id: 'u1', skillVerified: true });

      await service.verifySkill('u1', true);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { skillVerified: true },
        select: { id: true, skillVerified: true },
      });
    });
  });

  describe('company helpers', () => {
    it('createCompany attaches the userId', async () => {
      prisma.company.create.mockResolvedValue({ id: 'c1' });
      await service.createCompany('u1', { name: 'Acme' } as never);
      expect(prisma.company.create).toHaveBeenCalledWith({
        data: { name: 'Acme', userId: 'u1' },
      });
    });

    it('getCompany queries by userId', async () => {
      prisma.company.findUnique.mockResolvedValue({ id: 'c1' });
      await service.getCompany('u1');
      expect(prisma.company.findUnique.mock.calls[0][0].where).toEqual({ userId: 'u1' });
    });
  });

  describe('notifications', () => {
    it('markNotificationRead scopes update to owner', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      await service.markNotificationRead('n1', 'u1');
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n1', userId: 'u1' },
        data: { read: true },
      });
    });

    it('markAllNotificationsRead only touches unread notifications', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 3 });
      await service.markAllNotificationsRead('u1');
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', read: false },
        data: { read: true },
      });
    });
  });

  describe('saved jobs', () => {
    it('joins raw saved-job rows with their job details, dropping orphans', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: 's1', jobId: 'j1', createdAt: new Date() },
        { id: 's2', jobId: 'missing', createdAt: new Date() },
      ]);
      prisma.job.findMany.mockResolvedValue([{ id: 'j1', title: 'Dev' }]);

      const result = await service.getSavedJobs('u1');

      expect(result).toHaveLength(1);
      expect(result[0].job).toEqual({ id: 'j1', title: 'Dev' });
    });

    it('saveJob returns the composed identity', async () => {
      prisma.$executeRaw.mockResolvedValue(1);
      const result = await service.saveJob('u1', 'j1');
      expect(result).toMatchObject({ userId: 'u1', jobId: 'j1' });
      expect(typeof result.id).toBe('string');
    });

    it('removeSavedJob returns the affected count', async () => {
      prisma.$executeRaw.mockResolvedValue(1);
      await expect(service.removeSavedJob('u1', 'j1')).resolves.toEqual({ count: 1 });
    });
  });

  describe('cv drafts', () => {
    it('getCvDraft returns the first row or null', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(service.getCvDraft('u1')).resolves.toBeNull();

      prisma.$queryRaw.mockResolvedValue([
        { id: 'd1', userId: 'u1', data: {}, updatedAt: new Date() },
      ]);
      await expect(service.getCvDraft('u1')).resolves.toMatchObject({ id: 'd1' });
    });

    it('saveCvDraft echoes back the saved payload', async () => {
      prisma.$executeRaw.mockResolvedValue(1);
      const data = { headline: 'Engineer' };
      const result = await service.saveCvDraft('u1', data);
      expect(result).toMatchObject({ userId: 'u1', data });
    });
  });
});

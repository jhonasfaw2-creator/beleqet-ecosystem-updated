import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { JobsService } from './jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES } from '../queues/queues.constants';

jest.mock('../notifications/email-templates', () => ({
  jobPostConfirmationEmail: jest.fn().mockResolvedValue({ html: '<p>ok</p>', text: 'ok' }),
  jobAlertEmail: jest.fn().mockResolvedValue({ html: '<p>alert</p>', text: 'alert' }),
}));

describe('JobsService', () => {
  let service: JobsService;
  let prisma: {
    user: { findUnique: jest.Mock; findMany: jest.Mock };
    company: { findUnique: jest.Mock };
    job: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    jobCategory: { findMany: jest.Mock };
  };
  const config = { get: jest.fn(() => 'https://app.beleqet.com') };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      company: { findUnique: jest.fn() },
      job: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      jobCategory: { findMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: getQueueToken(QUEUE_NAMES.NOTIFICATIONS), useValue: queue },
      ],
    }).compile();

    service = module.get<JobsService>(JobsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('rejects when the employer has no company profile', async () => {
      prisma.user.findUnique.mockResolvedValue({ firstName: 'E', email: 'e@b.com' });
      prisma.company.findUnique.mockResolvedValue(null);
      await expect(service.create('emp1', { title: 'Dev' } as never)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('defaults status to PUBLISHED and coerces date strings to Date', async () => {
      prisma.user.findUnique.mockResolvedValue({ firstName: 'E', email: 'e@b.com' });
      prisma.company.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.job.create.mockResolvedValue({ id: 'j1', title: 'Dev', company: { name: 'Acme' } });

      await service.create('emp1', {
        title: 'Dev',
        deadline: '2026-01-01T00:00:00.000Z',
        expiryDate: '2026-02-01T00:00:00.000Z',
      } as never);

      const data = prisma.job.create.mock.calls[0][0].data;
      expect(data.companyId).toBe('c1');
      expect(data.status).toBe('PUBLISHED');
      expect(data.deadline).toBeInstanceOf(Date);
      expect(data.expiryDate).toBeInstanceOf(Date);
    });

    it('respects an explicitly provided status', async () => {
      prisma.user.findUnique.mockResolvedValue({ firstName: 'E', email: 'e@b.com' });
      prisma.company.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.job.create.mockResolvedValue({ id: 'j1', title: 'Dev', company: { name: 'Acme' } });

      await service.create('emp1', { title: 'Dev', status: 'DRAFT' } as never);

      expect(prisma.job.create.mock.calls[0][0].data.status).toBe('DRAFT');
    });
  });

  describe('findAll', () => {
    it('builds filters and computes pagination metadata', async () => {
      prisma.job.findMany.mockResolvedValue([{ id: 'j1' }]);
      prisma.job.count.mockResolvedValue(45);

      const result = await service.findAll({
        page: 2,
        limit: 20,
        q: 'react',
        category: 'eng',
        location: 'Addis',
        type: 'FULL_TIME',
      } as never);

      const where = prisma.job.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('PUBLISHED');
      expect(where.type).toBe('FULL_TIME');
      expect(where.category).toEqual({ slug: 'eng' });
      expect(where.location).toEqual({ contains: 'Addis', mode: 'insensitive' });
      expect(where.OR).toHaveLength(2);
      expect(prisma.job.findMany.mock.calls[0][0].skip).toBe(20);
      expect(result).toMatchObject({ total: 45, page: 2, limit: 20, totalPages: 3 });
    });

    it('falls back to defaults when no pagination is given', async () => {
      prisma.job.findMany.mockResolvedValue([]);
      prisma.job.count.mockResolvedValue(0);

      const result = await service.findAll({} as never);

      expect(prisma.job.findMany.mock.calls[0][0].skip).toBe(0);
      expect(result).toMatchObject({ page: 1, limit: 20, totalPages: 0 });
    });
  });

  describe('findOne', () => {
    it('returns the job when present', async () => {
      prisma.job.findUnique.mockResolvedValue({ id: 'j1' });
      await expect(service.findOne('j1')).resolves.toMatchObject({ id: 'j1' });
    });

    it('throws when absent', async () => {
      prisma.job.findUnique.mockResolvedValue(null);
      await expect(service.findOne('j1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update / remove ownership guard', () => {
    it('update throws when the job is not owned by the employer', async () => {
      prisma.job.findFirst.mockResolvedValue(null);
      await expect(service.update('j1', 'emp1', {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('update persists changes for an owned job', async () => {
      prisma.job.findFirst.mockResolvedValue({ id: 'j1' });
      prisma.job.update.mockResolvedValue({ id: 'j1', title: 'New' });
      await service.update('j1', 'emp1', { title: 'New' });
      expect(prisma.job.update).toHaveBeenCalledWith({
        where: { id: 'j1' },
        data: { title: 'New' },
      });
    });

    it('remove archives instead of deleting', async () => {
      prisma.job.findFirst.mockResolvedValue({ id: 'j1' });
      prisma.job.update.mockResolvedValue({ id: 'j1', status: 'ARCHIVED' });
      await service.remove('j1', 'emp1');
      expect(prisma.job.update).toHaveBeenCalledWith({
        where: { id: 'j1' },
        data: { status: 'ARCHIVED' },
      });
    });

    it('remove throws when the job is not owned', async () => {
      prisma.job.findFirst.mockResolvedValue(null);
      await expect(service.remove('j1', 'emp1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

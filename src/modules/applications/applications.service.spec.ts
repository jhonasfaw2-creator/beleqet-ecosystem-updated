import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bull';
import { ApplicationsService } from './applications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES } from '../queues/queues.constants';

jest.mock('../notifications/email-templates', () => ({
  applicationReceivedEmail: jest.fn().mockResolvedValue({ html: '<p>x</p>', text: 'x' }),
  applicationStatusEmail: jest.fn().mockResolvedValue({ html: '<p>y</p>', text: 'y' }),
}));

describe('ApplicationsService', () => {
  let service: ApplicationsService;
  let prisma: {
    job: { findFirst: jest.Mock };
    application: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    eventLog: { create: jest.Mock };
    notification: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let appQueue: { add: jest.Mock };
  let analyticsQueue: { add: jest.Mock };
  let notificationsQueue: { add: jest.Mock };
  const eventEmitter = { emit: jest.fn() };
  const config = { get: jest.fn(() => 'https://app.beleqet.com') };

  beforeEach(async () => {
    prisma = {
      job: { findFirst: jest.fn() },
      application: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      eventLog: { create: jest.fn() },
      notification: { create: jest.fn() },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
    };
    appQueue = { add: jest.fn().mockResolvedValue(undefined) };
    analyticsQueue = { add: jest.fn().mockResolvedValue(undefined) };
    notificationsQueue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ConfigService, useValue: config },
        { provide: getQueueToken(QUEUE_NAMES.APPLICATION), useValue: appQueue },
        { provide: getQueueToken(QUEUE_NAMES.ANALYTICS), useValue: analyticsQueue },
        { provide: getQueueToken(QUEUE_NAMES.NOTIFICATIONS), useValue: notificationsQueue },
      ],
    }).compile();

    service = module.get<ApplicationsService>(ApplicationsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('submit', () => {
    const dto = { jobId: 'j1', coverLetter: 'hi' } as never;

    it('throws when the job is not open', async () => {
      prisma.job.findFirst.mockResolvedValue(null);
      await expect(service.submit('u1', dto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the user has already applied', async () => {
      prisma.job.findFirst.mockResolvedValue({ id: 'j1', company: { name: 'Acme' } });
      prisma.application.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(service.submit('u1', dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates the application, logs the event and enqueues downstream jobs', async () => {
      prisma.job.findFirst.mockResolvedValue({
        id: 'j1',
        title: 'Dev',
        companyId: 'c1',
        company: { name: 'Acme' },
      });
      prisma.application.findUnique.mockResolvedValue(null);
      prisma.application.create.mockResolvedValue({
        id: 'a1',
        user: { id: 'u1', firstName: 'A', lastName: 'B', email: 'a@b.com' },
        job: { id: 'j1', title: 'Dev', companyId: 'c1' },
      });

      const result = await service.submit('u1', dto);

      expect(result).toMatchObject({ id: 'a1' });
      expect(prisma.eventLog.create).toHaveBeenCalledTimes(1);
      // screen candidate + notify recruiter
      expect(appQueue.add).toHaveBeenCalledTimes(2);
      expect(analyticsQueue.add).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'application.submitted',
        expect.objectContaining({ applicationId: 'a1' }),
      );
      // Allow the fire-and-forget email promise chain to resolve.
      await Promise.resolve();
      await Promise.resolve();
      expect(notificationsQueue.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByJob', () => {
    it('throws when the employer does not own the job', async () => {
      prisma.job.findFirst.mockResolvedValue(null);
      await expect(service.findByJob('j1', 'emp1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns applications ordered by score for an owned job', async () => {
      prisma.job.findFirst.mockResolvedValue({ id: 'j1' });
      prisma.application.findMany.mockResolvedValue([{ id: 'a1' }]);
      await expect(service.findByJob('j1', 'emp1')).resolves.toEqual([{ id: 'a1' }]);
    });
  });

  describe('findOne', () => {
    it('throws when the application is missing', async () => {
      prisma.application.findUnique.mockResolvedValue(null);
      await expect(service.findOne('a1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('throws when the application is not owned by the employer', async () => {
      prisma.application.findFirst.mockResolvedValue(null);
      await expect(service.updateStatus('a1', 'SHORTLISTED', 'emp1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('updates status, notifies the applicant and enqueues an email', async () => {
      prisma.application.findFirst.mockResolvedValue({
        id: 'a1',
        userId: 'u1',
        user: { email: 'a@b.com', firstName: 'A' },
        job: { title: 'Dev' },
      });
      prisma.application.update.mockResolvedValue({ id: 'a1', status: 'SHORTLISTED' });
      prisma.notification.create.mockResolvedValue({});

      const result = await service.updateStatus('a1', 'SHORTLISTED', 'emp1');

      expect(result).toMatchObject({ status: 'SHORTLISTED' });
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      expect(notificationsQueue.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('withdraw', () => {
    it('throws when the application cannot be withdrawn', async () => {
      prisma.application.findFirst.mockResolvedValue(null);
      await expect(service.withdraw('a1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('marks a withdrawable application as WITHDRAWN', async () => {
      prisma.application.findFirst.mockResolvedValue({ id: 'a1' });
      prisma.application.update.mockResolvedValue({ id: 'a1', status: 'WITHDRAWN' });
      await service.withdraw('a1', 'u1');
      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { status: 'WITHDRAWN' },
      });
    });
  });
});

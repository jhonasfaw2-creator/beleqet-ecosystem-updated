import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES } from '../queues/queues.constants';

// The email templates render React components; stub them so tests stay fast and
// isolated from the presentation layer.
jest.mock('../notifications/email-templates', () => ({
  passwordResetEmail: jest.fn().mockResolvedValue({ html: '<p>reset</p>', text: 'reset' }),
  verificationEmail: jest.fn().mockResolvedValue({ html: '<p>verify</p>', text: 'verify' }),
  loginAlertEmail: jest.fn().mockResolvedValue({ html: '<p>login</p>', text: 'login' }),
  logoutAlertEmail: jest.fn().mockResolvedValue({ html: '<p>logout</p>', text: 'logout' }),
  welcomeEmail: jest.fn().mockResolvedValue({ html: '<p>welcome</p>', text: 'welcome' }),
}));

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    refreshToken: {
      findUnique: jest.Mock;
      create: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
      findMany: jest.Mock;
    };
    verificationToken: {
      findUnique: jest.Mock;
      create: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let jwt: { sign: jest.Mock };
  let queue: { add: jest.Mock };
  const config = {
    get: jest.fn((key: string, fallback?: string) => {
      const values: Record<string, string> = {
        FRONTEND_URL: 'https://app.beleqet.com',
        JWT_ACCESS_SECRET: 'secret',
        JWT_ACCESS_EXPIRES: '15m',
      };
      return values[key] ?? fallback;
    }),
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      refreshToken: {
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      verificationToken: {
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    jwt = { sign: jest.fn().mockReturnValue('signed-access-token') };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: config },
        { provide: getQueueToken(QUEUE_NAMES.NOTIFICATIONS), useValue: queue },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => jest.clearAllMocks());

  const seekerDto = {
    email: 'New.User@Example.com ',
    password: 'Str0ngPass!',
    firstName: 'New',
    lastName: 'User',
  };

  describe('register', () => {
    it('rejects a duplicate email', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      await expect(service.register(seekerDto as never)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('hashes the password, normalises the email and defaults role to JOB_SEEKER', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const created = {
        id: 'u1',
        email: 'new.user@example.com',
        firstName: 'New',
        lastName: 'User',
        role: 'JOB_SEEKER',
      };
      prisma.user.create.mockResolvedValue(created);
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.register(seekerDto as never);

      const createArg = prisma.user.create.mock.calls[0][0];
      expect(createArg.data.email).toBe('new.user@example.com');
      expect(createArg.data.role).toBe('JOB_SEEKER');
      expect(createArg.data.passwordHash).not.toBe(seekerDto.password);
      expect(await bcrypt.compare(seekerDto.password, createArg.data.passwordHash)).toBe(true);
      expect(result).toMatchObject({
        accessToken: 'signed-access-token',
        user: { id: 'u1', role: 'JOB_SEEKER' },
      });
      expect(typeof result.refreshToken).toBe('string');
    });
  });

  describe('validateUser', () => {
    it('throws when the user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.validateUser('a@b.com', 'pw')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('throws when the account is deactivated', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: false, passwordHash: 'x' });
      await expect(service.validateUser('a@b.com', 'pw')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('throws on a wrong password', async () => {
      const passwordHash = await bcrypt.hash('correct', 4);
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: true, passwordHash });
      await expect(service.validateUser('a@b.com', 'wrong')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('returns the user on valid credentials', async () => {
      const passwordHash = await bcrypt.hash('correct', 4);
      const user = { id: 'u1', isActive: true, passwordHash };
      prisma.user.findUnique.mockResolvedValue(user);
      await expect(service.validateUser('a@b.com', 'correct')).resolves.toBe(user);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('migrates a legacy $wp$ hash to standard bcrypt on successful login', async () => {
      const standard = await bcrypt.hash('correct', 4);
      const wpHash = standard.replace('$2', '$wp$2');
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: true, passwordHash: wpHash });

      await service.validateUser('a@b.com', 'correct');

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      const updateArg = prisma.user.update.mock.calls[0][0];
      expect(updateArg.data.passwordHash.startsWith('$wp$')).toBe(false);
    });
  });

  describe('refresh', () => {
    it('rejects an unknown token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);
      await expect(service.refresh('nope')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an expired token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt1',
        expiresAt: new Date(Date.now() - 1000),
        user: { id: 'u1' },
      });
      await expect(service.refresh('old')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rotates a valid token and issues fresh tokens', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt1',
        expiresAt: new Date(Date.now() + 100000),
        user: { id: 'u1', email: 'a@b.com', firstName: 'A', lastName: 'B', role: 'JOB_SEEKER' },
      });
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.refresh('valid');

      expect(prisma.refreshToken.delete).toHaveBeenCalledWith({ where: { id: 'rt1' } });
      expect(result.accessToken).toBe('signed-access-token');
    });
  });

  describe('logout', () => {
    it('deletes all refresh tokens for the user', async () => {
      prisma.user.findUnique.mockResolvedValue({ email: 'a@b.com', firstName: 'A' });
      await service.logout('u1');
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    });
  });

  describe('verifyEmail', () => {
    it('rejects an invalid token', async () => {
      prisma.verificationToken.findUnique.mockResolvedValue(null);
      await expect(service.verifyEmail('t')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a token of the wrong type', async () => {
      prisma.verificationToken.findUnique.mockResolvedValue({
        id: 'v1',
        type: 'PASSWORD_RESET',
        expiresAt: new Date(Date.now() + 1000),
      });
      await expect(service.verifyEmail('t')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks the email verified and consumes the token', async () => {
      prisma.verificationToken.findUnique.mockResolvedValue({
        id: 'v1',
        userId: 'u1',
        type: 'EMAIL_VERIFICATION',
        expiresAt: new Date(Date.now() + 1000),
      });

      const result = await service.verifyEmail('t');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { emailVerified: true },
      });
      expect(prisma.verificationToken.delete).toHaveBeenCalledWith({ where: { id: 'v1' } });
      expect(result.success).toBe(true);
    });
  });

  describe('forgotPassword', () => {
    it('does not reveal whether the account exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const result = await service.forgotPassword('missing@b.com');
      expect(result.success).toBe(true);
      expect(prisma.verificationToken.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('creates a reset token and enqueues an email for a known account', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', firstName: 'A' });
      prisma.verificationToken.create.mockResolvedValue({});

      await service.forgotPassword('A@B.com');

      const tokenArg = prisma.verificationToken.create.mock.calls[0][0];
      expect(tokenArg.data.type).toBe('PASSWORD_RESET');
      expect(queue.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('resetPassword', () => {
    it('rejects an expired reset token', async () => {
      prisma.verificationToken.findUnique.mockResolvedValue({
        id: 'v1',
        type: 'PASSWORD_RESET',
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.resetPassword('t', 'new')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('hashes the new password and purges all reset tokens', async () => {
      prisma.verificationToken.findUnique.mockResolvedValue({
        id: 'v1',
        userId: 'u1',
        type: 'PASSWORD_RESET',
        expiresAt: new Date(Date.now() + 1000),
      });

      const result = await service.resetPassword('t', 'newSecret');

      const updateArg = prisma.user.update.mock.calls[0][0];
      expect(await bcrypt.compare('newSecret', updateArg.data.passwordHash)).toBe(true);
      expect(prisma.verificationToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', type: 'PASSWORD_RESET' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('issueTokens session cap', () => {
    it('prunes the oldest sessions beyond the 5-token cap', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
        role: 'JOB_SEEKER',
      });
      prisma.refreshToken.create.mockResolvedValue({});
      // 7 existing tokens -> 2 oldest should be deleted
      prisma.refreshToken.findMany.mockResolvedValue(
        Array.from({ length: 7 }, (_, i) => ({ id: `rt${i}` })),
      );

      await service.register(seekerDto as never);

      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['rt0', 'rt1'] } },
      });
    });
  });
});

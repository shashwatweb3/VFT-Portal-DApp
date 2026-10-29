import {
  BadRequestException,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PinataService } from './pinata.service';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { Express } from 'express';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { Readable } from 'stream';

// Server-side mirrors of the create form's checks: the browser limits are advisory only.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 1;
export const ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];
const UPLOADS_PER_IP_PER_HOUR = Number(process.env.UPLOADS_PER_IP_PER_HOUR ?? 20);

const recentUploads = new Map<string, number[]>();

/** Sliding one-hour window per client IP; idle entries are pruned so the map stays bounded. */
export function allowUpload(ip: string, now = Date.now()): boolean {
  const hourAgo = now - 3600_000;
  const recent = (recentUploads.get(ip) ?? []).filter((t) => t > hourAgo);
  if (recent.length >= UPLOADS_PER_IP_PER_HOUR) {
    recentUploads.set(ip, recent);
    return false;
  }
  recent.push(now);
  recentUploads.set(ip, recent);
  if (recentUploads.size > 10_000) {
    for (const [k, v] of recentUploads) if (!v.some((t) => t > hourAgo)) recentUploads.delete(k);
  }
  return true;
}

/**
 * Identifies the real image type from its first bytes. The client's Content-Type is not trusted:
 * an HTML or SVG file labelled image/png would otherwise be pinned and served from our gateway.
 */
export function sniffImage(buf: Buffer): string | undefined {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  return undefined;
}

/**
 * Rate limit by the connection's address as Express resolves it (`req.ip`, which honours the
 * `trust proxy` setting in main.ts). Runs as a guard, i.e. before multer buffers the upload.
 */
@Injectable()
export class UploadRateGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ ip?: string }>();
    if (!allowUpload(req.ip || 'unknown')) {
      throw new HttpException('too many uploads, try again later', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}

export type Result = {
  fileName: string;
  ipfsHash?: string;
  error?: string;
};

@Controller('files')
export class FileController {
  private logger = new Logger(FileController.name);

  constructor(private readonly pinataService: PinataService) {}

  @Post('upload')
  @UseGuards(UploadRateGuard)
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
      fileFilter: (_req, file, cb) =>
        ALLOWED_MIME.includes(file.mimetype)
          ? cb(null, true)
          : cb(new BadRequestException('only jpeg, png, webp or gif images'), false),
    }),
  )
  async upload(
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: { ip?: string },
  ): Promise<Result[]> {
    const ip = req.ip || 'unknown';
    if (!files?.length) {
      throw new BadRequestException('no file');
    }
    for (const file of files) {
      if (!file.size || !file.buffer?.length) throw new BadRequestException('empty file');
      if (sniffImage(file.buffer) === undefined) {
        throw new BadRequestException('only jpeg, png, webp or gif images');
      }
    }
    // Every upload is logged with its source so a takedown request can be traced.
    this.logger.log(`upload from ${ip}: ${files.map((f) => `${f.originalname} ${f.mimetype} ${f.size}B`).join(', ')}`);
    const names = files.map((file) => file.filename ?? file.originalname);
    try {
      const results = await Promise.all(
        files.map((file, index) => {
          return this.pinataService.uploadFile(
            Readable.from(file.buffer),
            names[index],
          );
        }),
      );
      return results.map((response, index) => {
        return {
          fileName: names[index],
          ipfsHash: response,
        };
      });
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException('failed to upload files');
    }
  }
}

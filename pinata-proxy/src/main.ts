import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Number of reverse proxies in front of this service; 0 means req.ip is the socket address and
  // a client-supplied X-Forwarded-For is ignored.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
  // Only the Tokenator frontends may upload from a browser.
  const allowed = (process.env.ALLOWED_ORIGINS ?? 'https://tokenator.club,http://localhost:3000')
    .split(',')
    .map((o) => o.trim());
  app.enableCors({ origin: allowed });
  const server = await app.listen(Number(process.env.PORT ?? 3000));
  server.setTimeout(1800000);
}
bootstrap();

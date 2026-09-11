// Load .env into process.env BEFORE any module is evaluated, so import-time
// config decisions (e.g. TelegramModule's conditional BullMQ registration, which
// reads REDIS_* at module-decoration time) see local-dev .env values too. In
// prod the platform sets real env vars, already present at import.
import 'dotenv/config';
import {ValidationPipe} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {DocumentBuilder, SwaggerModule} from '@nestjs/swagger';
import {json, NextFunction, Request, Response} from 'express';
import {AppModule} from './app.module';
import {AllExceptionsFilter} from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // An invoice-scan autosave carries the whole review — every row as the AI
  // read it plus the owner's edits — which a long note takes past express's
  // 100 KB default. Raised for that route only, and registered before Nest's
  // own parser so this one reads the body first. Wrapped in a closure on
  // purpose: Nest skips its global JSON parser when it finds a layer named
  // `jsonParser`, which would leave every other route unparsed.
  const scanJson = json({limit: '4mb'});
  app.use(
    '/ai/invoice/scans',
    (req: Request, res: Response, next: NextFunction) =>
      scanJson(req, res, next),
  );

  // Enable CORS for frontend
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Uniform error envelope for every failed request: { statusCode, code, message }.
  // The frontend localizes by `code`; `message` is an English fallback.
  app.useGlobalFilters(new AllExceptionsFilter());

  // Enable validation pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger configuration
  const config = new DocumentBuilder()
    .setTitle('KPOS CRM API')
    .setDescription('API documentation for KPOS CRM application')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .addTag('businesses', 'Business management endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('swagger', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  await app.listen(process.env.PORT ?? 3050, () => {
    console.log(`Server is running on port ${process.env.PORT ?? 3050}`);
  });
}
bootstrap();

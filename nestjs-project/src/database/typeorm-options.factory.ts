import { ConfigModule, type ConfigType } from '@nestjs/config';
import type {
  TypeOrmModuleAsyncOptions,
  TypeOrmModuleOptions,
} from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';

export const createTypeOrmOptions = (
  dbConfig: ConfigType<typeof databaseConfig>,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: dbConfig.host,
  port: dbConfig.port,
  username: dbConfig.username,
  password: dbConfig.password,
  database: dbConfig.name,
  autoLoadEntities: true,
  synchronize: false,
});

/** Shared by the API (AppModule) and the video worker (WorkerModule) */
export const typeOrmAsyncOptions: TypeOrmModuleAsyncOptions = {
  imports: [ConfigModule],
  inject: [databaseConfig.KEY],
  useFactory: createTypeOrmOptions,
};

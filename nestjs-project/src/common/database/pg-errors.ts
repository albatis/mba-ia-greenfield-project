import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

/** True when a TypeORM query failed on a unique constraint involving `column`. */
export function isUniqueViolationOn(error: unknown, column: string): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, detail } = error.driverError as {
    code?: string;
    detail?: string;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(`(${column})`)
  );
}

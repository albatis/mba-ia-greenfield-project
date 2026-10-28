export class StoragePartsRejectedError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'StoragePartsRejectedError';
  }
}

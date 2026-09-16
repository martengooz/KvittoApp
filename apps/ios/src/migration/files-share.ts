export interface FilesShareRequest {
  fileUri: string;
  mimeType: string;
  filename: string;
}

export interface FilesSharePort {
  share(request: FilesShareRequest): Promise<void>;
}

export interface ExportFilesIntegrationAdapter {
  shareArchive(fileUri: string, filename: string): Promise<void>;
}

export class MigrationFilesIntegrationAdapter implements ExportFilesIntegrationAdapter {
  constructor(private readonly files: FilesSharePort) {}

  async shareArchive(fileUri: string, filename: string): Promise<void> {
    await this.files.share({
      fileUri,
      mimeType: 'application/vnd.kvitto.archive+zip',
      filename,
    });
  }
}

export type WarningCode = 'missing_url' | 'unreadable_file' | 'empty_description';

export interface ParsedJob {
  url: string | null;
  body: string;
  warnings: WarningCode[];
}

export interface ScannedJob {
  source: 'folder';
  sourceRef: string;
  contentHash: string;
  url: string | null;
  body: string;
  warnings: WarningCode[];
}

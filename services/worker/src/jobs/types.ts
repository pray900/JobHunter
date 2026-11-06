export type WarningCode = 'missing_url' | 'unreadable_file' | 'empty_description';

export interface ParsedJob {
  url: string | null;
  body: string;
  warnings: WarningCode[];
}

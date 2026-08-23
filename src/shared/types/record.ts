export type RecordKind = "text" | "audio";

export type CaptureStatus =
  | "none"
  | "preparing"
  | "recording"
  | "paused"
  | "stopping"
  | "finalizing"
  | "ready"
  | "interrupted"
  | "failed";

export type TranscriptionStatus =
  | "not_applicable"
  | "unavailable"
  | "not_started"
  | "queued"
  | "live"
  | "lagging"
  | "recovering"
  | "finalizing"
  | "ready"
  | "failed";

export type DiarizationStatus =
  | "not_applicable"
  | "queued"
  | "running"
  | "ready"
  | "failed";

export interface AudioRecordSummary {
  mediaDurationMs: number;
  captureStatus: CaptureStatus;
  transcriptionStatus: TranscriptionStatus;
  diarizationStatus: DiarizationStatus;
  tracks: Array<"microphone" | "system" | "mixed">;
  sizeBytes: number;
}

export interface RecordSummary {
  id: string;
  kind: RecordKind;
  title: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  convertedTaskIds: string[];
  revision: number;
  audio?: AudioRecordSummary;
}

export interface RecordDetail extends RecordSummary {
  content?: string;
  images?: string[];
}

export type RecordArchiveFilter = "active" | "archived" | "all";

export interface RecordListFilter {
  kind?: RecordKind;
  tag?: string;
  query?: string;
  limit?: number;
  archived?: RecordArchiveFilter;
}

export interface TextRecordCreateInput {
  content: string;
  images?: string[];
}

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  /** Null when the source carries no audio stream. */
  audioCodec: string | null;
  /** ffprobe's `format_name`, split on commas — MP4 reports several. */
  containerFormats: string[];
  sizeBytes: number;
}

/** The raw ffprobe JSON, only as far as we read it. */
export interface FfprobeOutput {
  format?: {
    duration?: string;
    format_name?: string;
    size?: string;
  };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
  }[];
}

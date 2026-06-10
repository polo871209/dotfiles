export type Severity = "error" | "warn" | "info" | "hint";

export interface Diag {
  file: string;
  line: number;
  col: number;
  severity: Severity;
  source?: string;
  code?: string;
  message: string;
}

export interface DriverResult {
  formatted: string[];
  diagnostics: Diag[];
}

import type { Diag } from "../utils";

export type { Severity, Diag } from "../utils";

export interface DriverResult {
  formatted: string[];
  diagnostics: Diag[];
}

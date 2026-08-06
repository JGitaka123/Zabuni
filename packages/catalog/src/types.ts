export const catalogFields = [
  "sku",
  "description",
  "brand",
  "packSize",
  "uom",
  "costMinor",
  "costCurrency",
  "fxBufferBps",
  "taxClass",
  "kraItemCode",
  "hsCode",
  "leadTimeDays",
  "minMarginBps",
  "active"
] as const;

export type CatalogField = (typeof catalogFields)[number];
export type TaxClass = "standard_16" | "zero_rated" | "exempt";

export type ColumnMapping = Readonly<Partial<Record<CatalogField, string>>>;

export interface ParsedTable {
  readonly headers: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

export interface CatalogInput {
  readonly sku: string;
  readonly description: string;
  readonly brand?: string;
  readonly packSize?: string;
  readonly uom?: string;
  readonly costMinor?: string;
  readonly costCurrency?: string;
  readonly fxBufferBps?: number;
  readonly taxClass: TaxClass;
  readonly kraItemCode?: string;
  readonly hsCode?: string;
  readonly leadTimeDays?: number;
  readonly minMarginBps?: number;
  readonly active: boolean;
}

export interface ImportIssue {
  readonly code:
    | "duplicate_sku"
    | "invalid_active"
    | "invalid_bps"
    | "invalid_currency"
    | "invalid_integer"
    | "invalid_money"
    | "invalid_tax_class"
    | "missing_mapping"
    | "missing_required"
    | "unsafe_text";
  readonly field?: CatalogField;
  readonly message: string;
}

export interface ValidatedImportRow {
  readonly kind: "valid";
  readonly rowNumber: number;
  readonly source: Readonly<Record<string, string>>;
  readonly value: CatalogInput;
}

export interface StagedImportRow {
  readonly kind: "staged";
  readonly rowNumber: number;
  readonly reason: "missing_tax_class";
  readonly value: Omit<CatalogInput, "taxClass">;
  readonly source: Readonly<Record<string, string>>;
  readonly issues: readonly ImportIssue[];
}

export interface RejectedImportRow {
  readonly kind: "rejected";
  readonly rowNumber: number;
  readonly source: Readonly<Record<string, string>>;
  readonly issues: readonly ImportIssue[];
}

export type ImportRow = ValidatedImportRow | StagedImportRow | RejectedImportRow;

export interface ImportPreview {
  readonly headers: readonly string[];
  readonly mapping: ColumnMapping;
  readonly rows: readonly ImportRow[];
  readonly validCount: number;
  readonly stagedCount: number;
  readonly rejectedCount: number;
}

import { currencyCode } from "@zabuni/core";

import {
  catalogFields,
  type CatalogField,
  type CatalogInput,
  type ColumnMapping,
  type ImportIssue,
  type ImportPreview,
  type ImportRow,
  type ParsedTable,
  type TaxClass
} from "./types.js";

const TAX_CLASSES = new Set<TaxClass>(["standard_16", "zero_rated", "exempt"]);
const SAFE_SKU = /^[\p{L}\p{N}][\p{L}\p{N} ._\-/]{0,127}$/u;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) return true;
  }
  return false;
}

function issue(code: ImportIssue["code"], message: string, field?: CatalogField): ImportIssue {
  return Object.freeze({ code, message, ...(field === undefined ? {} : { field }) });
}

function mapped(
  source: Readonly<Record<string, string>>,
  mapping: ColumnMapping,
  field: CatalogField
): string {
  const heading = mapping[field];
  return heading === undefined ? "" : (source[heading] ?? "").trim();
}

function optionalText(
  raw: string,
  field: CatalogField,
  maximum: number,
  issues: ImportIssue[]
): string | undefined {
  if (raw === "") return undefined;
  if (raw.length > maximum || hasControlCharacters(raw)) {
    issues.push(
      issue("unsafe_text", `${field} contains unsupported characters or is too long`, field)
    );
    return undefined;
  }
  return raw;
}

function integer(
  raw: string,
  field: CatalogField,
  minimum: number,
  maximum: number,
  issues: ImportIssue[]
): number | undefined {
  if (raw === "") return undefined;
  if (!/^-?\d+$/.test(raw)) {
    issues.push(
      issue(
        field.endsWith("Bps") ? "invalid_bps" : "invalid_integer",
        `${field} must be a base-10 integer`,
        field
      )
    );
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issues.push(
      issue(
        field.endsWith("Bps") ? "invalid_bps" : "invalid_integer",
        `${field} must be between ${String(minimum)} and ${String(maximum)}`,
        field
      )
    );
    return undefined;
  }
  return value;
}

function booleanValue(raw: string, issues: ImportIssue[]): boolean {
  if (raw === "") return true;
  const normalized = raw.toLocaleLowerCase("en-KE");
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["false", "no", "0"].includes(normalized)) return false;
  issues.push(issue("invalid_active", "active must be true/false, yes/no, or 1/0", "active"));
  return true;
}

function validateRow(
  source: Readonly<Record<string, string>>,
  mapping: ColumnMapping,
  rowNumber: number,
  duplicateSkus: Set<string>
): ImportRow {
  const issues: ImportIssue[] = [];
  const sku = mapped(source, mapping, "sku");
  const description = mapped(source, mapping, "description");
  if (sku === "") issues.push(issue("missing_required", "sku is required", "sku"));
  else if (!SAFE_SKU.test(sku))
    issues.push(issue("unsafe_text", "sku contains unsupported characters or is too long", "sku"));
  const skuKey = sku.toLocaleLowerCase("en-KE");
  if (sku !== "" && duplicateSkus.has(skuKey)) {
    issues.push(issue("duplicate_sku", `Duplicate SKU in import: ${sku}`, "sku"));
  }
  duplicateSkus.add(skuKey);

  if (description === "")
    issues.push(issue("missing_required", "description is required", "description"));
  else if (description.length > 2_000 || hasControlCharacters(description)) {
    issues.push(
      issue(
        "unsafe_text",
        "description contains unsupported characters or is too long",
        "description"
      )
    );
  }

  const rawCost = mapped(source, mapping, "costMinor");
  const rawCurrency = mapped(source, mapping, "costCurrency").toUpperCase();
  let costMinor: string | undefined;
  if (rawCost !== "") {
    if (!/^\d+$/.test(rawCost))
      issues.push(
        issue(
          "invalid_money",
          "costMinor must be a non-negative minor-unit integer string",
          "costMinor"
        )
      );
    else costMinor = BigInt(rawCost).toString();
  }
  let costCurrency: string | undefined;
  if (rawCurrency !== "") {
    try {
      costCurrency = currencyCode(rawCurrency);
    } catch {
      issues.push(
        issue(
          "invalid_currency",
          "costCurrency must be a recognized uppercase ISO-4217 code",
          "costCurrency"
        )
      );
    }
  }
  if ((rawCost === "") !== (rawCurrency === "")) {
    issues.push(
      issue(
        "invalid_money",
        "costMinor and costCurrency must be supplied together",
        rawCost === "" ? "costMinor" : "costCurrency"
      )
    );
  }

  const rawTaxClass = mapped(source, mapping, "taxClass");
  let taxClass: TaxClass | undefined;
  if (rawTaxClass !== "") {
    if (TAX_CLASSES.has(rawTaxClass as TaxClass)) taxClass = rawTaxClass as TaxClass;
    else
      issues.push(
        issue(
          "invalid_tax_class",
          "taxClass must be standard_16, zero_rated, or exempt",
          "taxClass"
        )
      );
  }

  const brand = optionalText(mapped(source, mapping, "brand"), "brand", 200, issues);
  const packSize = optionalText(mapped(source, mapping, "packSize"), "packSize", 100, issues);
  const uom = optionalText(mapped(source, mapping, "uom"), "uom", 50, issues);
  const fxBufferBps = integer(
    mapped(source, mapping, "fxBufferBps"),
    "fxBufferBps",
    0,
    1_000_000,
    issues
  );
  const kraItemCode = optionalText(
    mapped(source, mapping, "kraItemCode"),
    "kraItemCode",
    100,
    issues
  );
  const hsCode = optionalText(mapped(source, mapping, "hsCode"), "hsCode", 100, issues);
  const leadTimeDays = integer(
    mapped(source, mapping, "leadTimeDays"),
    "leadTimeDays",
    0,
    36_500,
    issues
  );
  const minMarginBps = integer(
    mapped(source, mapping, "minMarginBps"),
    "minMarginBps",
    0,
    10_000,
    issues
  );
  const value: Omit<CatalogInput, "taxClass"> = {
    sku,
    description,
    active: booleanValue(mapped(source, mapping, "active"), issues),
    ...(brand === undefined ? {} : { brand }),
    ...(packSize === undefined ? {} : { packSize }),
    ...(uom === undefined ? {} : { uom }),
    ...(costMinor === undefined ? {} : { costMinor }),
    ...(costCurrency === undefined ? {} : { costCurrency }),
    ...(fxBufferBps === undefined ? {} : { fxBufferBps }),
    ...(kraItemCode === undefined ? {} : { kraItemCode }),
    ...(hsCode === undefined ? {} : { hsCode }),
    ...(leadTimeDays === undefined ? {} : { leadTimeDays }),
    ...(minMarginBps === undefined ? {} : { minMarginBps })
  };

  if (issues.length > 0) {
    return Object.freeze({ kind: "rejected", rowNumber, source, issues: Object.freeze(issues) });
  }
  if (taxClass === undefined) {
    return Object.freeze({
      kind: "staged",
      rowNumber,
      reason: "missing_tax_class",
      value: Object.freeze(value),
      source,
      issues: Object.freeze([
        issue(
          "missing_required",
          "taxClass requires human classification before import",
          "taxClass"
        )
      ])
    });
  }
  return Object.freeze({
    kind: "valid",
    rowNumber,
    source,
    value: Object.freeze({ ...value, taxClass })
  });
}

export function previewImport(table: ParsedTable, mapping: ColumnMapping): ImportPreview {
  const issues: ImportIssue[] = [];
  for (const required of ["sku", "description"] as const) {
    if (mapping[required] === undefined)
      issues.push(issue("missing_mapping", `${required} must be mapped`, required));
  }
  for (const [field, heading] of Object.entries(mapping) as [CatalogField, string][]) {
    if (!catalogFields.includes(field) || !table.headers.includes(heading)) {
      issues.push(
        issue("missing_mapping", `${field} maps to a heading that does not exist`, field)
      );
    }
  }
  if (issues.length > 0) {
    throw new CatalogMappingError(issues);
  }

  const duplicateSkus = new Set<string>();
  const rows = table.rows.map((row, index) => validateRow(row, mapping, index + 2, duplicateSkus));
  return Object.freeze({
    headers: table.headers,
    mapping: Object.freeze({ ...mapping }),
    rows: Object.freeze(rows),
    validCount: rows.filter((row) => row.kind === "valid").length,
    stagedCount: rows.filter((row) => row.kind === "staged").length,
    rejectedCount: rows.filter((row) => row.kind === "rejected").length
  });
}

export class CatalogMappingError extends Error {
  readonly issues: readonly ImportIssue[];
  constructor(issues: readonly ImportIssue[]) {
    super("Catalog column mapping is invalid");
    this.name = "CatalogMappingError";
    this.issues = Object.freeze([...issues]);
  }
}

export class CatalogValidationError extends Error {
  readonly issues: readonly ImportIssue[];
  constructor(issues: readonly ImportIssue[]) {
    super("Catalog input is invalid");
    this.name = "CatalogValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

/** Validates API-shaped input without coercing money from a JSON number. */
export function validateCatalogInput(input: unknown): CatalogInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CatalogValidationError([
      issue("missing_required", "Catalog input must be an object")
    ]);
  }
  const record = input as Record<string, unknown>;
  const source: Record<string, string> = {};
  const typeIssues: ImportIssue[] = [];
  const integerFields = new Set<CatalogField>(["fxBufferBps", "leadTimeDays", "minMarginBps"]);
  for (const field of catalogFields) {
    const value = record[field];
    if (value === undefined) source[field] = "";
    else if (field === "active") {
      if (typeof value !== "boolean") {
        typeIssues.push(issue("invalid_active", "active must be a boolean", field));
      } else source[field] = String(value);
    } else if (integerFields.has(field)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        typeIssues.push(
          issue(
            field.endsWith("Bps") ? "invalid_bps" : "invalid_integer",
            `${field} must be a safe integer`,
            field
          )
        );
      } else source[field] = String(value);
    } else if (typeof value !== "string") {
      typeIssues.push(
        issue(
          field === "costMinor" ? "invalid_money" : "unsafe_text",
          `${field} must be a string`,
          field
        )
      );
    } else source[field] = value;
  }
  if (typeIssues.length > 0) throw new CatalogValidationError(typeIssues);

  const row = previewImport(
    { headers: catalogFields, rows: [source] },
    Object.fromEntries(catalogFields.map((field) => [field, field]))
  ).rows[0];
  if (row?.kind !== "valid") {
    throw new CatalogValidationError(
      row?.issues ?? [issue("missing_required", "Catalog input is empty")]
    );
  }
  return row.value;
}

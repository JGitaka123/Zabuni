import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  CatalogMappingError,
  CatalogValidationError,
  parseCsv,
  parseXlsx,
  previewImport,
  validateCatalogInput
} from "../src/index.js";

const mapping = {
  sku: " Product Code ",
  description: "ITEM DESCRIPTION",
  costMinor: "Cost (cents)",
  costCurrency: "CCY",
  taxClass: "KRA Tax",
  minMarginBps: "Margin bps",
  active: "Enabled?"
} as const;

describe("catalog parsing and preview", () => {
  it("parses messy explicit headings and quoted CSV without guessing columns", () => {
    const table = parseCsv(
      Buffer.from(
        "\uFEFF Product Code ,ITEM DESCRIPTION,Cost (cents),CCY,KRA Tax,Margin bps,Enabled?\n" +
          'ANT-HW-5000,"Soap, antibacterial 5L",123456,KES,standard_16,2500,yes\n'
      )
    );

    expect(table.headers).toEqual([
      "Product Code",
      "ITEM DESCRIPTION",
      "Cost (cents)",
      "CCY",
      "KRA Tax",
      "Margin bps",
      "Enabled?"
    ]);
    const preview = previewImport(table, { ...mapping, sku: "Product Code" });
    expect(preview).toMatchObject({ validCount: 1, stagedCount: 0, rejectedCount: 0 });
    const row = preview.rows[0];
    expect(row?.kind).toBe("valid");
    if (row?.kind === "valid") {
      expect(row.value).toMatchObject({
        sku: "ANT-HW-5000",
        description: "Soap, antibacterial 5L",
        costMinor: "123456",
        costCurrency: "KES",
        taxClass: "standard_16",
        minMarginBps: 2500,
        active: true
      });
    }
  });

  it("reads the first XLSX worksheet offline and keeps cell text", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Catalog");
    sheet.addRow(["SKU #", "Description / Name", "Minor Units", "Currency", "Tax"]);
    sheet.addRow(["PPE-001", "Nitrile gloves, box", "000999", "KES", "zero_rated"]);
    const bytes = await workbook.xlsx.writeBuffer();

    const table = await parseXlsx(Buffer.from(bytes));
    const preview = previewImport(table, {
      sku: "SKU #",
      description: "Description / Name",
      costMinor: "Minor Units",
      costCurrency: "Currency",
      taxClass: "Tax"
    });
    const row = preview.rows[0];
    expect(row?.kind).toBe("valid");
    if (row?.kind === "valid") expect(row.value.costMinor).toBe("999");
  });

  it("rejects empty and over-wide workbooks before iterating unsafe row widths", async () => {
    expect(() => parseCsv(Buffer.from("sku,description\n"))).toThrow(/no data rows/i);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Catalog");
    sheet.addRow(Array.from({ length: 101 }, (_, index) => `column-${String(index)}`));
    sheet.addRow(Array.from({ length: 101 }, () => "value"));
    const bytes = await workbook.xlsx.writeBuffer();
    await expect(parseXlsx(Buffer.from(bytes))).rejects.toThrow(/at most 100 columns/i);
  });

  it("stages an otherwise valid row with no tax class and never infers one", () => {
    const table = parseCsv(Buffer.from("sku,description,tax\nA-1,Hand soap,\n"));
    const preview = previewImport(table, {
      sku: "sku",
      description: "description",
      taxClass: "tax"
    });

    expect(preview).toMatchObject({ validCount: 0, stagedCount: 1, rejectedCount: 0 });
    expect(preview.rows[0]).toMatchObject({ kind: "staged", reason: "missing_tax_class" });
  });

  it("rejects duplicate SKUs case-insensitively", () => {
    const table = parseCsv(
      Buffer.from("sku,description,tax\nABC-1,First,exempt\nabc-1,Second,standard_16\n")
    );
    const preview = previewImport(table, {
      sku: "sku",
      description: "description",
      taxClass: "tax"
    });

    expect(preview).toMatchObject({ validCount: 1, rejectedCount: 1 });
    expect(preview.rows[1]).toMatchObject({
      kind: "rejected",
      issues: [expect.objectContaining({ code: "duplicate_sku" })]
    });
  });

  it.each(["12.34", "1e3", "-1", "KES 100", "NaN"])(
    "rejects non-integer minor-unit money %s",
    (money) => {
      const table = parseCsv(
        Buffer.from(`sku,description,cost,currency,tax\nA,Item,${money},KES,exempt\n`)
      );
      const preview = previewImport(table, {
        sku: "sku",
        description: "description",
        costMinor: "cost",
        costCurrency: "currency",
        taxClass: "tax"
      });
      const row = preview.rows[0];
      expect(row?.kind).toBe("rejected");
      if (row?.kind === "rejected") {
        expect(row.issues.map((problem) => problem.code)).toContain("invalid_money");
      }
    }
  );

  it.each(["standard", "16%", "vat", "STANDARD_16", "unknown"])(
    "rejects non-explicit tax class %s",
    (taxClass) => {
      const table = parseCsv(Buffer.from(`sku,description,tax\nA,Item,${taxClass}\n`));
      const preview = previewImport(table, {
        sku: "sku",
        description: "description",
        taxClass: "tax"
      });
      expect(preview.rows[0]).toMatchObject({
        kind: "rejected",
        issues: [expect.objectContaining({ code: "invalid_tax_class" })]
      });
    }
  );

  it("rejects unsafe fields, invalid currencies, and out-of-range integers", () => {
    const table = parseCsv(
      Buffer.from(
        "sku,description,cost,currency,tax,margin,lead\n" +
          '"bad\u0001sku",Item,100,NOT,exempt,10001,-2\n'
      )
    );
    const preview = previewImport(table, {
      sku: "sku",
      description: "description",
      costMinor: "cost",
      costCurrency: "currency",
      taxClass: "tax",
      minMarginBps: "margin",
      leadTimeDays: "lead"
    });
    const row = preview.rows[0];
    expect(row?.kind).toBe("rejected");
    if (row?.kind === "rejected") {
      expect(row.issues.map((problem) => problem.code)).toEqual(
        expect.arrayContaining([
          "unsafe_text",
          "invalid_currency",
          "invalid_bps",
          "invalid_integer"
        ])
      );
    }
  });

  it("requires explicit mappings and rejects duplicate headings", () => {
    const table = parseCsv(Buffer.from("SKU,Description\nA,Item\n"));
    expect(() => previewImport(table, { sku: "SKU" })).toThrow(CatalogMappingError);
    expect(() => parseCsv(Buffer.from("SKU,sku\nA,B\n"))).toThrow(/unique/i);
  });

  it("validates direct API input without accepting numeric money or inferred tax", () => {
    expect(
      validateCatalogInput({
        sku: "API-1",
        description: "Validated item",
        costMinor: "1050",
        costCurrency: "KES",
        taxClass: "exempt",
        active: true
      })
    ).toMatchObject({ costMinor: "1050", taxClass: "exempt" });

    for (const invalid of [
      {
        sku: "API-2",
        description: "Numeric money",
        costMinor: 10,
        costCurrency: "KES",
        taxClass: "exempt"
      },
      { sku: "API-3", description: "Missing tax", active: true }
    ]) {
      expect(() => validateCatalogInput(invalid)).toThrow(CatalogValidationError);
    }
  });

  it("cannot reach the network in fixture tests", async () => {
    await expect(fetch("https://example.com/catalog.xlsx")).rejects.toThrow();
  });
});

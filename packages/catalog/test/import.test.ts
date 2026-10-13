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

describe("decimal prices on import", () => {
  const priceMapping = {
    sku: "Code",
    description: "Description",
    cost: "Unit Price",
    costCurrency: "CCY",
    taxClass: "KRA Tax"
  } as const;

  const previewOf = (price: string, currency = "KES") =>
    previewImport(
      {
        headers: ["Code", "Description", "Unit Price", "CCY", "KRA Tax"],
        rows: [
          {
            Code: "ANT-HW-5000",
            Description: "Soap, antibacterial 5L",
            "Unit Price": price,
            CCY: currency,
            "KRA Tax": "standard_16"
          }
        ]
      },
      priceMapping
    ).rows[0];

  it("reads the price shapes a real export contains", () => {
    // This is the whole point: a distributor's price list holds major units
    // with separators, not integer cents, so requiring cents meant no real
    // catalog could be imported without being transformed first.
    for (const [price, expected] of [
      ["1234.56", "123456"],
      ["1,234.56", "123456"],
      ["KSh 1,234.56", "123456"],
      ["1,500/=", "150000"],
      ["1234", "123400"],
      ["1234.5", "123450"],
      ["0.07", "7"]
    ] as const) {
      const row = previewOf(price);
      expect(row?.kind, price).toBe("valid");
      if (row?.kind === "valid") expect(row.value.costMinor, price).toBe(expected);
    }
  });

  it("uses the row's currency to decide the decimal places", () => {
    const shillings = previewOf("1500", "UGX");
    expect(shillings?.kind).toBe("valid");
    if (shillings?.kind === "valid") expect(shillings.value.costMinor).toBe("1500");

    const dinars = previewOf("1.234", "KWD");
    expect(dinars?.kind).toBe("valid");
    if (dinars?.kind === "valid") expect(dinars.value.costMinor).toBe("1234");
  });

  it("rejects a price written in another currency rather than rescaling it", () => {
    const row = previewOf("USD 40.00", "KES");
    expect(row?.kind).toBe("rejected");
    if (row?.kind === "rejected") {
      expect(row.issues.map((entry) => entry.code)).toContain("invalid_currency");
    }
  });

  it("rejects ambiguous and inexact prices with the reason in the message", () => {
    for (const price of ["1.234,56", "1 234,56", "1234,56", "1234.567", "n/a", "-5.00"]) {
      const row = previewOf(price);
      expect(row?.kind, price).toBe("rejected");
      if (row?.kind === "rejected") {
        expect(
          row.issues.some((entry) => entry.field === "cost"),
          price
        ).toBe(true);
        expect(row.issues[0]?.message.length, price).toBeGreaterThan(10);
      }
    }
  });

  it("refuses a row that gives both a decimal cost and minor units", () => {
    const row = previewImport(
      {
        headers: ["Code", "Description", "Unit Price", "Cents", "CCY", "KRA Tax"],
        rows: [
          {
            Code: "A1",
            Description: "Bleach 5L",
            "Unit Price": "1234.56",
            Cents: "123456",
            CCY: "KES",
            "KRA Tax": "exempt"
          }
        ]
      },
      { ...priceMapping, costMinor: "Cents" }
    ).rows[0];

    expect(row?.kind).toBe("rejected");
    if (row?.kind === "rejected") {
      expect(row.issues.map((entry) => entry.code)).toContain("conflicting_money");
    }
  });

  it("still reads an integer costMinor column exactly as before", () => {
    // Guards the thing that would have been catastrophic: reinterpreting an
    // existing costMinor column as major units divides every price by a hundred.
    const row = previewImport(
      {
        headers: ["Code", "Description", "Cents", "CCY", "KRA Tax"],
        rows: [
          {
            Code: "A1",
            Description: "Bleach 5L",
            Cents: "123456",
            CCY: "KES",
            "KRA Tax": "exempt"
          }
        ]
      },
      {
        sku: "Code",
        description: "Description",
        costMinor: "Cents",
        costCurrency: "CCY",
        taxClass: "KRA Tax"
      }
    ).rows[0];

    expect(row?.kind).toBe("valid");
    if (row?.kind === "valid") expect(row.value.costMinor).toBe("123456");
  });

  it("requires a currency alongside a decimal cost", () => {
    const row = previewImport(
      {
        headers: ["Code", "Description", "Unit Price", "KRA Tax"],
        rows: [
          {
            Code: "A1",
            Description: "Bleach 5L",
            "Unit Price": "1234.56",
            "KRA Tax": "exempt"
          }
        ]
      },
      { sku: "Code", description: "Description", cost: "Unit Price", taxClass: "KRA Tax" }
    ).rows[0];

    expect(row?.kind).toBe("rejected");
    if (row?.kind === "rejected") {
      expect(row.issues.some((entry) => entry.message.includes("currency"))).toBe(true);
    }
  });

  it("accepts a decimal cost through the JSON API shape too", () => {
    expect(
      validateCatalogInput({
        sku: "A1",
        description: "Bleach 5L",
        cost: "1,234.56",
        costCurrency: "KES",
        taxClass: "exempt",
        active: true
      })
    ).toMatchObject({ costMinor: "123456", costCurrency: "KES" });
  });
});

describe("ragged rows", () => {
  const header = "Code,Description,CCY\n";

  it("refuses a row with more values than there are headings", () => {
    // A shifted row is the dangerous case: without this it imported silently,
    // with the surplus value discarded and everything after it off by one.
    expect(() => parseCsv(Buffer.from(`${header}A1,Bleach 5L,KES,999\n`))).toThrow(
      /Row 2 has 1 more value/u
    );
  });

  it("names the offending row by the number the preview will show", () => {
    expect(() => parseCsv(Buffer.from(`${header}A1,Bleach 5L,KES\nA2,Soap 1L,KES,oops\n`))).toThrow(
      /Row 3 /u
    );
  });

  it("forgives a trailing delimiter, which carries no value", () => {
    const table = parseCsv(Buffer.from(`${header}A1,Bleach 5L,KES,\n`));

    expect(table.rows).toEqual([{ Code: "A1", Description: "Bleach 5L", CCY: "KES" }]);
  });

  it("still pads a row that is short of the headings", () => {
    const table = parseCsv(Buffer.from(`${header}A1,Bleach 5L\n`));

    expect(table.rows).toEqual([{ Code: "A1", Description: "Bleach 5L", CCY: "" }]);
  });
});

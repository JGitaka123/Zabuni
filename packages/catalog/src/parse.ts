import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";

import type { ParsedTable } from "./types.js";

/**
 * A problem with the uploaded file itself, as opposed to a problem with a
 * value inside it. Every message names something about the user's own file and
 * carries no internal detail, so the API returns it verbatim -- a bare
 * "validation failed" left a tester with no idea what to change.
 */
export class CatalogParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogParseError";
  }
}

const MAX_ROWS = 20_000;
const MAX_COLUMNS = 100;
const MAX_CELL_LENGTH = 10_000;
const MAX_XLSX_ENTRIES = 1_000;
const MAX_XLSX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_XLSX_COMPRESSION_RATIO = 100;

function guardXlsxArchive(buffer: Buffer): void {
  let entries = 0;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  for (let offset = 0; offset <= buffer.length - 46; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    entries += 1;
    compressedBytes += buffer.readUInt32LE(offset + 20);
    uncompressedBytes += buffer.readUInt32LE(offset + 24);
    if (entries > MAX_XLSX_ENTRIES || uncompressedBytes > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new CatalogParseError("The XLSX archive exceeds safe resource limits");
    }
  }
  if (entries === 0) throw new CatalogParseError("The XLSX archive is invalid");
  if (compressedBytes > 0 && uncompressedBytes / compressedBytes > MAX_XLSX_COMPRESSION_RATIO) {
    throw new CatalogParseError("The XLSX archive compression ratio exceeds safe limits");
  }
}

function cleanCell(value: string): string {
  const cleaned = value.replace(/^\uFEFF/, "").trim();
  if (cleaned.length > MAX_CELL_LENGTH) {
    throw new CatalogParseError(`A catalog cell exceeds ${String(MAX_CELL_LENGTH)} characters`);
  }
  return cleaned;
}

function tableFromMatrix(matrix: readonly (readonly string[])[]): ParsedTable {
  const [headerRow, ...dataRows] = matrix;
  if (headerRow === undefined || headerRow.length === 0) {
    throw new CatalogParseError("The catalog file has no header row");
  }
  if (headerRow.length > MAX_COLUMNS) {
    throw new CatalogParseError(`Catalog files may contain at most ${String(MAX_COLUMNS)} columns`);
  }

  const headers = headerRow.map(cleanCell);
  if (headers.some((header) => header.length === 0)) {
    throw new CatalogParseError("Every catalog column must have a non-blank heading");
  }
  const normalized = headers.map((header) => header.toLocaleLowerCase("en-KE"));
  if (new Set(normalized).size !== normalized.length) {
    throw new CatalogParseError("Catalog column headings must be unique (case-insensitive)");
  }
  if (dataRows.length > MAX_ROWS) {
    throw new CatalogParseError(`Catalog files may contain at most ${String(MAX_ROWS)} data rows`);
  }

  const rows = dataRows
    .map((row, index) => {
      // Cells past the last heading have nowhere to go. Dropping them quietly
      // would be the worst outcome of all: a row shifted by one column imports
      // a plausible-looking price against the wrong SKU, and the preview the
      // user is asked to check would show the same wrong thing the commit
      // writes. A trailing delimiter is forgiven, since the overflow is empty.
      const overflow = row.slice(headers.length).map(cleanCell);
      if (overflow.some((value) => value !== "")) {
        throw new CatalogParseError(
          `Row ${String(index + 2)} has ${String(overflow.filter((value) => value !== "").length)} ` +
            `more values than there are column headings; every value must sit under a heading`
        );
      }
      return headers.reduce<Record<string, string>>((result, header, position) => {
        result[header] = cleanCell(row[position] ?? "");
        return result;
      }, {});
    })
    .filter((row) => Object.values(row).some((value) => value !== ""));

  if (rows.length === 0) throw new CatalogParseError("The catalog file has no data rows");

  return Object.freeze({ headers: Object.freeze(headers), rows: Object.freeze(rows) });
}

export function parseCsv(buffer: Buffer): ParsedTable {
  const records = parse(buffer, {
    bom: true,
    columns: false,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: false
  }) as unknown;
  if (!Array.isArray(records)) {
    throw new CatalogParseError("Unable to parse the CSV catalog");
  }
  const matrix = records.map((record) => {
    if (!Array.isArray(record)) {
      throw new CatalogParseError("CSV rows must contain columns");
    }
    return record.map((cell) => String(cell));
  });
  return tableFromMatrix(matrix);
}

function excelCellText(cell: ExcelJS.Cell): string {
  if (cell.type === ExcelJS.ValueType.Formula) {
    throw new CatalogParseError(
      "Formula cells are not accepted in catalog imports; paste values first"
    );
  }
  if (cell.value instanceof Date) {
    throw new CatalogParseError("Date cells are not accepted in catalog imports");
  }
  return cell.text;
}

export async function parseXlsx(buffer: Buffer): Promise<ParsedTable> {
  guardXlsxArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  const bytes = Uint8Array.from(buffer);
  await workbook.xlsx.load(bytes.buffer);
  const worksheet = workbook.worksheets[0];
  if (worksheet === undefined) {
    throw new CatalogParseError("The workbook has no worksheet");
  }
  if (worksheet.actualRowCount > MAX_ROWS + 1) {
    throw new CatalogParseError(`Catalog files may contain at most ${String(MAX_ROWS)} data rows`);
  }

  const matrix: string[][] = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    if (row.cellCount > MAX_COLUMNS || row.actualCellCount > MAX_COLUMNS) {
      throw new CatalogParseError(
        `Catalog files may contain at most ${String(MAX_COLUMNS)} columns`
      );
    }
    const cells: string[] = [];
    for (let column = 1; column <= row.cellCount; column += 1) {
      cells.push(excelCellText(row.getCell(column)));
    }
    matrix.push(cells);
  });
  return tableFromMatrix(matrix);
}

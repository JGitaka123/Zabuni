"use client";

import { useEffect, useState, type FormEvent } from "react";

import { apiOrigin } from "../../lib/public-config";

type TaxClass = "standard_16" | "zero_rated" | "exempt";

interface CatalogItem {
  readonly id: string;
  readonly sku: string;
  readonly description: string;
  readonly taxClass: TaxClass;
  readonly costMinor: string | null;
  readonly costCurrency: string | null;
  readonly active: boolean;
}

interface ImportCounts {
  readonly total: number;
  readonly valid: number;
  readonly staged: number;
  readonly rejected: number;
}

interface ImportIssue {
  readonly field?: string;
  readonly message: string;
}

interface ImportProblemRow {
  readonly kind: "staged" | "rejected";
  readonly rowNumber: number;
  readonly source: Readonly<Record<string, string>>;
  readonly issues: readonly ImportIssue[];
}

function isImportCounts(value: unknown): value is ImportCounts {
  if (typeof value !== "object" || value === null) return false;
  return ["total", "valid", "staged", "rejected"].every(
    (key) => key in value && typeof value[key as keyof typeof value] === "number"
  );
}

function isImportProblemRow(value: unknown): value is ImportProblemRow {
  if (typeof value !== "object" || value === null) return false;
  const kind = "kind" in value ? value.kind : undefined;
  return (
    (kind === "staged" || kind === "rejected") &&
    "rowNumber" in value &&
    typeof value.rowNumber === "number" &&
    "source" in value &&
    typeof value.source === "object" &&
    value.source !== null &&
    "issues" in value &&
    Array.isArray(value.issues)
  );
}

async function apiJson(
  path: string,
  init?: RequestInit
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${apiOrigin}${path}`, { credentials: "include", ...init });
  return { response, body: (await response.json()) as unknown };
}

function errorLabel(body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = Reflect.get(body, "error");
    if (typeof error === "string") return error.replaceAll("_", " ");
  }
  return "request could not be completed";
}

export default function CatalogPage() {
  const [items, setItems] = useState<readonly CatalogItem[]>([]);
  const [sku, setSku] = useState("");
  const [description, setDescription] = useState("");
  const [taxClass, setTaxClass] = useState<TaxClass | "">("");
  const [taxClassificationBasis, setTaxClassificationBasis] = useState("");
  const [costMinor, setCostMinor] = useState("");
  const [costCurrency, setCostCurrency] = useState("KES");
  const [file, setFile] = useState<File>();
  const [headers, setHeaders] = useState<readonly string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importId, setImportId] = useState<string>();
  const [counts, setCounts] = useState<ImportCounts>();
  const [problemRows, setProblemRows] = useState<readonly ImportProblemRow[]>([]);
  const [classificationChoices, setClassificationChoices] = useState<Record<number, TaxClass>>({});
  const [classificationNotes, setClassificationNotes] = useState<Record<number, string>>({});
  const [itemTaxChoices, setItemTaxChoices] = useState<Record<string, TaxClass>>({});
  const [itemTaxNotes, setItemTaxNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  async function loadItems() {
    const { response, body } = await apiJson("/catalog/items");
    if (!response.ok || typeof body !== "object" || body === null || !("items" in body)) {
      setMessage(errorLabel(body));
      return;
    }
    const result = Reflect.get(body, "items");
    if (Array.isArray(result)) setItems(result as CatalogItem[]);
  }

  useEffect(() => {
    void loadItems().catch(() => {
      setMessage("catalog unavailable");
    });
  }, []);

  async function createItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const payload = {
      sku,
      description,
      taxClass,
      taxClassificationBasis,
      active: true,
      ...(costMinor === "" ? {} : { costMinor, costCurrency })
    };
    const { response, body } = await apiJson("/catalog/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      setMessage(errorLabel(body));
      return;
    }
    setSku("");
    setDescription("");
    setTaxClass("");
    setTaxClassificationBasis("");
    setCostMinor("");
    setMessage("Item created.");
    await loadItems();
  }

  async function archiveItem(itemId: string) {
    const { response, body } = await apiJson(`/catalog/items/${itemId}`, { method: "DELETE" });
    setMessage(response.ok ? "Item archived." : errorLabel(body));
    if (response.ok) await loadItems();
  }

  async function reclassifyItem(item: CatalogItem) {
    const selected = itemTaxChoices[item.id];
    const basis = itemTaxNotes[item.id]?.trim() ?? "";
    if (selected === undefined || selected === item.taxClass || basis === "") {
      setMessage("Choose a different tax class and record the reclassification basis.");
      return;
    }
    const { response, body } = await apiJson(`/catalog/items/${item.id}/tax-class`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taxClass: selected, basisNote: basis })
    });
    if (!response.ok) {
      setMessage(errorLabel(body));
      return;
    }
    setMessage(`Tax class changed for ${item.sku}; the prior class remains in the audit history.`);
    await loadItems();
  }

  async function inspectFile() {
    if (file === undefined) return;
    const form = new FormData();
    form.set("file", file);
    const { response, body } = await apiJson("/catalog/imports/inspect", {
      method: "POST",
      body: form
    });
    if (!response.ok || typeof body !== "object" || body === null) {
      setMessage(errorLabel(body));
      return;
    }
    const nextHeaders: unknown = "headers" in body ? body.headers : undefined;
    if (!Array.isArray(nextHeaders) || !nextHeaders.every((value) => typeof value === "string")) {
      setMessage("catalog headings could not be read");
      return;
    }
    setHeaders(nextHeaders);
    setMapping({});
    setCounts(undefined);
    setProblemRows([]);
    setClassificationChoices({});
    setClassificationNotes({});
    setImportId(undefined);
    setMessage("Choose the source column for each catalog field.");
  }

  async function previewImport() {
    if (file === undefined) return;
    const form = new FormData();
    form.set("file", file);
    form.set("mapping", JSON.stringify(mapping));
    const { response, body } = await apiJson("/catalog/imports/preview", {
      method: "POST",
      body: form
    });
    if (!response.ok || typeof body !== "object" || body === null) {
      setMessage(errorLabel(body));
      return;
    }
    const nextCounts: unknown = "counts" in body ? body.counts : undefined;
    const nextImportId: unknown = "importId" in body ? body.importId : undefined;
    const nextRows: unknown = "rows" in body ? body.rows : undefined;
    if (!isImportCounts(nextCounts) || typeof nextImportId !== "string" || !Array.isArray(nextRows)) {
      setMessage("import preview was incomplete");
      return;
    }
    setCounts(nextCounts);
    setProblemRows(
      nextRows.filter((row): row is ImportProblemRow => isImportProblemRow(row))
    );
    setImportId(nextImportId);
    setMessage(
      nextCounts.staged + nextCounts.rejected === 0
        ? "Preview is ready to commit."
        : "Resolve staged or rejected rows before committing."
    );
  }

  async function commitImport() {
    if (importId === undefined) return;
    const { response, body } = await apiJson(`/catalog/imports/${importId}/commit`, {
      method: "POST"
    });
    if (!response.ok) {
      setMessage(errorLabel(body));
      return;
    }
    setMessage("Catalog import committed.");
    setImportId(undefined);
    await loadItems();
  }

  async function classifyRow(rowNumber: number) {
    if (importId === undefined) return;
    const selected = classificationChoices[rowNumber];
    const basisNote = classificationNotes[rowNumber]?.trim() ?? "";
    if (selected === undefined || basisNote === "") {
      setMessage("Choose a tax class and record the classification basis.");
      return;
    }
    const { response, body } = await apiJson(
      `/catalog/imports/${importId}/rows/${String(rowNumber)}/tax-class`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taxClass: selected, basisNote })
      }
    );
    if (!response.ok) {
      setMessage(errorLabel(body));
      return;
    }
    setProblemRows((current) => current.filter((row) => row.rowNumber !== rowNumber));
    setCounts((current) =>
      current === undefined
        ? undefined
        : { ...current, valid: current.valid + 1, staged: current.staged - 1 }
    );
    setMessage(`Row ${String(rowNumber)} classified. No tax class was inferred.`);
  }

  function mappingSelect(field: string, label: string, required = false) {
    return (
      <label>
        {label}
        {required ? " *" : ""}
        <select
          value={mapping[field] ?? ""}
          onChange={(event) => {
            setMapping((current) => {
              if (event.target.value === "") {
                return Object.fromEntries(Object.entries(current).filter(([key]) => key !== field));
              }
              return { ...current, [field]: event.target.value };
            });
          }}
        >
          <option value="">Not mapped</option>
          {headers.map((header) => (
            <option key={header} value={header}>
              {header}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <main className="catalog-main">
      <header className="catalog-header">
        <div>
          <p className="eyebrow">Catalog operations</p>
          <h1>Items and imports</h1>
        </div>
        <a href="/shell">Tenant session</a>
      </header>

      <p role="status" className="status-line">
        {message}
      </p>

      <section className="catalog-grid">
        <div className="panel catalog-panel">
          <h2>Create item</h2>
          <p>Tax classification is explicit and never inferred.</p>
          <form
            onSubmit={(event) => {
              void createItem(event);
            }}
          >
            <label>
              SKU
              <input required value={sku} onChange={(event) => { setSku(event.target.value); }} />
            </label>
            <label>
              Description
              <input
                required
                value={description}
                onChange={(event) => { setDescription(event.target.value); }}
              />
            </label>
            <label>
              KRA tax class
              <select
                required
                value={taxClass}
                onChange={(event) => { setTaxClass(event.target.value as TaxClass); }}
              >
                <option value="">Choose explicitly</option>
                <option value="standard_16">Standard 16%</option>
                <option value="zero_rated">Zero-rated</option>
                <option value="exempt">Exempt</option>
              </select>
            </label>
            <label>
              Classification basis
              <input
                required
                maxLength={1000}
                placeholder="Record the supplier, KRA, or reviewed source"
                value={taxClassificationBasis}
                onChange={(event) => {
                  setTaxClassificationBasis(event.target.value);
                }}
              />
            </label>
            <label>
              Cost in minor units (optional)
              <input
                inputMode="numeric"
                pattern="[0-9]+"
                value={costMinor}
                onChange={(event) => { setCostMinor(event.target.value); }}
              />
            </label>
            <label>
              Cost currency
              <input
                maxLength={3}
                value={costCurrency}
                onChange={(event) => { setCostCurrency(event.target.value.toUpperCase()); }}
              />
            </label>
            <button type="submit">Create item</button>
          </form>
        </div>

        <div className="panel catalog-panel">
          <h2>Import CSV or XLSX</h2>
          <input
            type="file"
            accept=".csv,.xlsx"
            onChange={(event) => {
              setFile(event.target.files?.[0]);
              setHeaders([]);
              setCounts(undefined);
              setProblemRows([]);
              setImportId(undefined);
            }}
          />
          <button type="button" disabled={file === undefined} onClick={() => void inspectFile()}>
            Inspect headings
          </button>
          {headers.length > 0 ? (
            <div className="mapping-grid">
              {mappingSelect("sku", "SKU", true)}
              {mappingSelect("description", "Description", true)}
              {mappingSelect("taxClass", "KRA tax class")}
              {mappingSelect("brand", "Brand")}
              {mappingSelect("packSize", "Pack size")}
              {mappingSelect("uom", "Unit of measure")}
              {mappingSelect("costMinor", "Cost minor units")}
              {mappingSelect("costCurrency", "Cost currency")}
              {mappingSelect("leadTimeDays", "Lead time days")}
              <button type="button" onClick={() => void previewImport()}>
                Validate and stage
              </button>
            </div>
          ) : null}
          {counts === undefined ? null : (
            <dl>
              <dt>Total rows</dt>
              <dd>{counts.total}</dd>
              <dt>Valid</dt>
              <dd>{counts.valid}</dd>
              <dt>Needs classification</dt>
              <dd>{counts.staged}</dd>
              <dt>Rejected</dt>
              <dd>{counts.rejected}</dd>
            </dl>
          )}
          {problemRows.length === 0 ? null : (
            <div className="import-problems">
              <h3>Rows needing attention</h3>
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>SKU</th>
                    <th>Field</th>
                    <th>Issue</th>
                    <th>Explicit class</th>
                    <th>Classification basis</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {problemRows.flatMap((row) =>
                    row.issues.map((issue, index) => (
                      <tr key={`${String(row.rowNumber)}-${String(index)}`}>
                        <td>{row.rowNumber}</td>
                        <td>{row.source[mapping.sku ?? ""] ?? "—"}</td>
                        <td>{issue.field ?? "row"}</td>
                        <td>{issue.message}</td>
                        <td>
                          {row.kind === "staged" ? (
                            <select
                              aria-label={`Tax class for row ${String(row.rowNumber)}`}
                              value={classificationChoices[row.rowNumber] ?? ""}
                              onChange={(event) => {
                                if (event.target.value !== "") {
                                  setClassificationChoices((current) => ({
                                    ...current,
                                    [row.rowNumber]: event.target.value as TaxClass
                                  }));
                                }
                              }}
                            >
                              <option value="">Choose explicitly</option>
                              <option value="standard_16">Standard 16%</option>
                              <option value="zero_rated">Zero-rated</option>
                              <option value="exempt">Exempt</option>
                            </select>
                          ) : (
                            "Fix source file"
                          )}
                        </td>
                        <td>
                          {row.kind === "staged" ? (
                            <input
                              aria-label={`Classification basis for row ${String(row.rowNumber)}`}
                              maxLength={1000}
                              placeholder="e.g. reviewed supplier/KRA record"
                              value={classificationNotes[row.rowNumber] ?? ""}
                              onChange={(event) => {
                                setClassificationNotes((current) => ({
                                  ...current,
                                  [row.rowNumber]: event.target.value
                                }));
                              }}
                            />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          {row.kind === "staged" ? (
                            <button
                              type="button"
                              onClick={() => {
                                void classifyRow(row.rowNumber);
                              }}
                            >
                              Confirm class
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <p>Correct these rows in the source file, then inspect and validate it again.</p>
            </div>
          )}
          <button
            type="button"
            disabled={
              importId === undefined || counts === undefined || counts.staged + counts.rejected > 0
            }
            onClick={() => void commitImport()}
          >
            Commit valid import
          </button>
        </div>
      </section>

      <section className="catalog-table-wrap">
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Description</th>
              <th>Tax</th>
              <th>Cost</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.sku}</td>
                <td>{item.description}</td>
                <td>{item.taxClass}</td>
                <td className="money-cell">
                  {item.costMinor === null ? "—" : `${item.costCurrency ?? ""} ${item.costMinor}`}
                </td>
                <td>{item.active ? "Active" : "Archived"}</td>
                <td>
                  <select
                    aria-label={`New tax class for ${item.sku}`}
                    value={itemTaxChoices[item.id] ?? ""}
                    onChange={(event) => {
                      if (event.target.value !== "") {
                        setItemTaxChoices((current) => ({
                          ...current,
                          [item.id]: event.target.value as TaxClass
                        }));
                      }
                    }}
                  >
                    <option value="">Reclassify…</option>
                    <option value="standard_16">Standard 16%</option>
                    <option value="zero_rated">Zero-rated</option>
                    <option value="exempt">Exempt</option>
                  </select>
                  <input
                    aria-label={`Reclassification basis for ${item.sku}`}
                    maxLength={1000}
                    placeholder="Required basis"
                    value={itemTaxNotes[item.id] ?? ""}
                    onChange={(event) => {
                      setItemTaxNotes((current) => ({
                        ...current,
                        [item.id]: event.target.value
                      }));
                    }}
                  />
                  <button
                    type="button"
                    disabled={!item.active}
                    onClick={() => {
                      void reclassifyItem(item);
                    }}
                  >
                    Change tax class
                  </button>
                  <button
                    type="button"
                    disabled={!item.active}
                    onClick={() => void archiveItem(item.id)}
                  >
                    Archive
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

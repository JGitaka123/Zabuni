# Q-2 tax classification workflow

**Status:** implemented and verified on 2026-08-06.

## Scope

Q-2 lets an owner or manager explicitly classify otherwise-valid staged catalog rows. Every decision records the selected KRA class, the acting user, a required internal basis note, and a timestamp. No class is suggested or inferred. Finance and other roles remain read-only because expanding legal classification authority was not approved; broader authorization is an explicit owner decision.

## Database invariants

- Unclassified data remains outside `items`; `items.tax_class` stays `NOT NULL`, without a default, and constrained to the three documented values.
- Classification and import recounting occur in one tenant transaction while locking the import and row.
- A database trigger rejects any transition to `committed` unless stored row count, required fields, validation errors, and tax classifications all agree.
- Classification evidence is append-only and tenant-isolated.

## Deliberate boundary

Quote, order, invoice, and invoice-line tables do not exist yet. Q-2 therefore cannot add the eventual invoice-line foreign-key/check gate without building ahead. The catalog-side invariant is database-enforced now; the invoice-side constraint must be added with the task that first introduces invoiceable lines (Q-7/E-3) and must reference only classified `items`.

That later schema must store an immutable per-line tax snapshot and item/service provenance. Looking only at the item's current class during transmission would corrupt historical correctness after reclassification.

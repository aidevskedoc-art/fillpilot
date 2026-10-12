# FillPilot

(Working name until 2026-10-09: "PDF Form Assistant" — folder and package
names still say so.)

Upload a PDF once, extract its data automatically, then let a Chrome extension
fill the matching fields of a web form. The user reviews every mapping first,
and the extension **never submits** the form.

```
backend/     Node.js + Express + PostgreSQL. PDF extraction, field matching, auth, audit   :4100
web/         Angular 21 workspace
  projects/dashboard   web app: upload, review/correct data, mappings, activity, users     :4300
  projects/shared      API types + helpers, also used by the extension
extension/   Chrome MV3 extension, bundled with esbuild (build.mjs)
  src/content/         content script: scan + fill the page
  src/panel/           side panel (React): sign in, choose document, review, Fill
```

Extraction and matching are **rule-based**: no AI, and no data leaves your server.
`AI_PROVIDER` is reserved for an optional assist layer later. Never send patient
data to a free-tier AI API.

## First-time setup (Windows, PowerShell)

Prerequisites: Node 24, and PostgreSQL running on `localhost:5432`.

```powershell
# 1. Backend
cd backend
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue   # drops a temporary offline shim
npm.cmd install
npm.cmd start          # creates pdf_form_db, tables, the first Admin, and the alias dictionary
```

`backend/.env` is already set for the local database. The first Admin's
username and password are `ADMIN_USERNAME` / `ADMIN_PASSWORD` in that file. The
password is not the PostgreSQL password. Change it after the first sign-in (Users
page). If sign-in fails, or the account got locked after 5 attempts, run
`npm.cmd run reset-admin`. That resets the Admin to the `.env` values and unlocks it.

```powershell
# 2. Dashboard (new terminal)
cd web
npm.cmd install
npm.cmd start          # http://localhost:4300 (proxies /api to :4100)

# 3. Extension (the side panel is React, bundled by esbuild — no Angular build needed)
cd extension
npm.cmd install
npm.cmd run build      # or: npm.cmd run watch   (rebuilds on change)
```

Then go to `chrome://extensions`, turn on **Developer mode**, click **Load
unpacked**, and select `extension/dist`. The extension ID is fixed
(`fjikihdjljokehgbcjdccbojpogdmadc`) by the `key` in `manifest.json`, so it
matches `CORS_ORIGIN` in `backend/.env`. For another backend URL, build with
`$env:API_BASE="https://…"; npm.cmd run build`.

## Try it end to end

1. Dashboard → **Mappings → Allowed sites**: add `http://localhost:4100` (the
   demo forms). The extension refuses every site that isn't on this list.
2. Dashboard → **Documents**: upload a PDF. When it shows *Completed*, open it to
   check and correct the extracted fields. (Or upload from the extension panel:
   **Upload a PDF**.)
3. Open `http://localhost:4100/demo/forms/hospital-registration.html` (or
   `insurance-preauth.html`, which has the hard cases).
4. Click the extension icon. The side panel opens; sign in, choose the
   document, then click **Scan this page**.
5. Review the list. Green rows are ready to fill. Amber rows need a decision:
   pick the PDF field from the dropdown, and tick *Remember for this form* to
   save it for next time. Then click **Fill**.
6. Check the form and submit it yourself. **Activity** shows what was filled
   (labels and outcomes only, never values).

The demo forms are **synthetic**. Before user testing, add the real target
website and try it there.

## TGNPDCL medical bill entry (Yashoda bills)

1. Open the draft bill on `essp.tgnpdcl.com/medical-bill-entry/…`. The site
   must be approved (`node scripts/allow-site.js https://essp.tgnpdcl.com "TGNPDCL"`)
   and enabled once in the panel. The panel switches to **TGNPDCL bill entry**
   mode.
2. Click **Choose bill PDFs** and pick the patient's Yashoda **final bill** and
   **summary bill** together. They are printed as images, so the server reads
   them with the OCR built into Windows — locally, about 15 seconds for an
   11-page pair. Every amount is checked against the bill's own totals, and section
   totals are compared between the two bills.

   **The bill is not stored.** The PDFs are read from memory and the result is
   handed back to the panel (`POST /api/claims/tgnpdcl`): no file in
   `backend/storage/`, no row in the database. The panel keeps the bill in
   `chrome.storage.session` — memory only — until **Finished — clear this
   bill**, sign-out, or the browser closes. The activity log records which
   steps ran (field names, tariff codes), never what was typed.
3. Filling stays blocked until the IP number on the site matches the bills —
   checked again before every Fill.
4. For each tab, click **Fill …** and check the result. Fill moves to its tab
   with the site's own Next button when needed (the site's tabs do not open on
   a click); going back is left to you. The extension clicks only Next and the
   add-row buttons. It never saves, submits or ticks declarations.

The generic mode (any PDF, any approved site, and the dashboard) does keep
what it reads in the database — for `RETENTION_DAYS`, without the PDF when
`KEEP_PDF=false`.

Not filled automatically, and listed in the panel: pharmacy rows (the bill
has only a total), implants (chosen by department on the site), and
specializations missing from the bill. If a step can't find something on the
site, its result names the missing label. **Copy page structure** copies the
page's labels and buttons (no patient data) so the profile in
`extension/src/panel/tgnpdcl-plan.ts` can be updated.

## Giving it to a PC that cannot install anything (the client package)

```powershell
node package\build-package.js     # → release\FillPilot  (about 160 MB)
node package\zip-package.js       # → release\FillPilot.zip
```

The package runs from its folder: unzip, double-click `FillPilot-Start.cmd`,
load the `extension` folder in Chrome (`package\README.txt` is the guide that
ships with it). It has **no database**:

- the backend in it is `backend/src/reader-server.js` — it reads bill PDFs and
  answers; no accounts, nothing stored, this PC only, the extension only;
- the extension in it is the `MODE=reader` build — the sign-in
  (`panel/local-account.ts`), the approved websites (`config.json`) and the
  activity log (`panel/activity-log.ts`, **Export activity log** in the panel)
  live in Chrome's own storage;
- it fills TGNPDCL bills only — the dashboard and the any-PDF mode need the
  full backend with PostgreSQL.

The only program in the package is `node.exe`, which is digitally signed.
That is deliberate: PCs that stop unsigned programs running from ordinary
folders killed an earlier package that carried PostgreSQL.

## Tests

```powershell
cd backend
npm.cmd run test-unit     # normalization, extraction on real PDFs, matching rules
npm.cmd run test-routes   # HTTP + PostgreSQL (uses a separate pdf_form_db_test database)
npm.cmd run profile-pdf -- path\to\file.pdf all   # see how a new PDF layout is read
```

`backend/test-fixtures/` holds real sample PDFs (patient data). It is
**gitignored**, so keep it that way. `expected.json` there lists values read by
hand from each PDF.

## How it works

**Extraction** (`backend/src/extraction/`). It rebuilds each page from pdfjs
text positions into lines and column segments. Then it applies rules in order
of strength:
- inline `Label : Value`
- label and value in neighbouring columns
- a header row over a value row
- `Label:` with the value on the next lines
- a known label above a centred value
- `From` / `To` qualifiers

Labels resolve to canonical keys (`patientName`, `dateOfBirth`, …) through the
alias dictionary, which you can edit in Mappings. Values are typed and
normalized (ISO dates, 10-digit phones, `₹25,000` → `25000`), and the raw value
is always kept. The extractor also lowers confidence for:
- running headers and footers, and policy-wording pages
- the issuer's own contact details

**Matching** (`backend/src/matching/`). The server does all matching, using
page labels sent by the extension. Each mapping is scored by four layers in
order:

| Layer | Score |
|---|---|
| Saved mapping for this site and form | 100% |
| Exact label match | 98% |
| Alias match | 95% |
| Token similarity | up to 90% |

The score is then adjusted for field type and scaled by extraction confidence.
- **Matched (≥ 85%):** pre-ticked.
- **Review (60–85%):** never auto-filled, and neither are ambiguous cases (one
  PDF address against three address fields) or a dropdown with no matching
  option.
- **Formatting:** dates are rewritten into the page's format, and dropdowns
  only ever get one of their own options.

**Extension**: it is injected on demand, only into approved sites the user
enabled. It fills with the native value setter plus input/change events, so
React and Angular forms see the values. It keeps the session token in
`chrome.storage.session` (memory only) and never submits.

## Known limitations (MVP)

- Member tables with multi-line headers (e.g. insured persons' DOB/age in UIIC
  schedules) aren't parsed into fields yet. Add the value under **Add field** on
  the document page, or wait for Phase 3 intelligent tables.
- Scanned PDFs are rejected with a clear message. OCR comes in Phase 2.
- Names split across two columns ("PABBISETTY | BHARGAVASAI") come out
  truncated.
- The panel uses one document at a time. The API already accepts several, and
  conflicts are detected.
- Shadow-DOM form fields are not detected. The extension has no custom icon
  yet.

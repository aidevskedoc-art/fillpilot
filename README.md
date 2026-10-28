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
`$env:API_BASE="https://…"; npm.cmd run build` — or change it in the installed
extension: the gear icon (top bar and sign-in screen) shows the server address
and whether it answers, and **Change** points that browser at another server.

## Try it end to end

1. Dashboard → **Mappings → Allowed sites**: add `http://localhost:4100` (the
   demo forms). The extension refuses every site that isn't on this list.
2. In the extension panel, **Upload a PDF**. (The dashboard no longer has a
   Documents page: it shows the bills read on the three sites instead.)
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

   OCR confuses I with 1 and O with 0, so every field is repaired by what its
   place can hold: IP / YH numbers, amounts and dates are digits, names have no
   digits, invoice numbers are `ICO` + 7 digits, and codes follow their shape
   (`formats/yashoda.js`). The one place a shape cannot settle is the last
   character of a NIMS code — `78I` (TSH) and `781` are both codes. The panel
   shows such a code as `78I (or 781)`, and Fill adds the reading whose price on
   the site equals the bill's rate; when the prices don't settle it, the step
   is marked for you to check.
4. For each tab, click **Fill …** and check the result. Fill moves to its tab
   with the site's own Next button when needed (the site's tabs do not open on
   a click); going back is left to you. The extension clicks only Next and the
   add-row buttons. It never saves, submits or ticks declarations.

## Coal India IP claim (e-Arogya Suvidha, Yashoda bills)

1. Approve the site once (`node scripts/allow-site.js https://www.cilbpa.utiitsl.com "Coal India e-BPA"` —
   with `www.`: the address must match the browser's exactly, and Chrome hides `https://www.`)
   and enable it in the panel. On `www.cilbpa.utiitsl.com/coal/…` the panel switches to
   **Bill Details · Coal India**.
2. Drop the patient's final bill and summary bill. They are read like the TGNPDCL
   bills (`POST /api/claims/cil`), and nothing is stored.
3. Open the claim's **Bill Details** tab yourself, then press **Fill Bill Details**:
   - **Bill No.** comes from the summary bill's invoice number, and **Bill Date** is the discharge date.
   - **CGHS List Items:** one row per code (CC008, LB037…), with the quantities of all its bill
     lines added up (CC008 for SDP and blood component transfusion → quantity 2). FillPilot types
     the code (the site fills in the name), the quantity and the services in Remarks, pressing the
     blue **+** for each next row. It keeps the site's own rate and marks the rows whose amount
     differs from the bill.
   - **Unlisted Procedures:** with the name, quantity and the bill's rate —
     the hospital's own codes (YSSH, see `OWN_CODES` in `formats/yashoda.js`),
     the codes Coal India takes as unlisted (BC002, BC006 — `UNLISTED_CODES` in
     `claims/cil.js`; add a code there to move it), and room rent (Item Code
     `ROOM RENT`, the bill's description, days × rate per day, Remarks `ROOM RENT`).
     The site does not take an Unlisted row with Remarks empty: the others get the
     item's name there.
   - **Last step:** it checks the Pharmacy Amount and the Grand Total against the bill's net amount.
4. Left to you, and listed in the panel: Room Details on the Admission tab (the panel
   reminds you of the days and amount), ICU / ICCU bed charges, doctor fees, lines without a code,
   the prior-approval tick, update Room / update Date, Save As Draft and Submit IP Bill.
   FillPilot never presses the red ✗. Rows already on the site are not added twice, so
   **Fill again** carries on after a stop.

The generic mode (any PDF, any approved site, and the dashboard) does keep
what it reads in the database — for `RETENTION_DAYS`, without the PDF when
`KEEP_PDF=false`.

Not filled automatically, and listed in the panel: pharmacy rows (the bill
has only a total), implants (chosen by department on the site),
specializations missing from the bill, and the hospital's own codes (YSSH —
in no tariff list; listed apart with name, quantity, rate and amount until the
site's non-tariff entry is profiled). If a step can't find something on the
site, its result names the missing label. **Copy page structure** copies the
page's labels and buttons (no patient data) so the profile in
`extension/src/panel/tgnpdcl-plan.ts` can be updated.

## Team report (Admin)

Dashboard → **Team report**: per person, for a period (today, last 7 days, this
month, last month or any dates), the bills read per site (TGNPDCL / PM-JAY /
Coal India — one final + summary bill is one), PDFs and pages, how many times
Fill was pressed and the steps it did or could not do, and when they were last
active. Everyone with an active account is listed, so whoever is not using
FillPilot shows with zeros. **Export CSV** saves the table.

The same report without the dashboard (only the backend's database is needed):

```powershell
cd backend
npm.cmd run team-report -- 2026-10-01 2026-10-31   # both days included; no dates = this month so far
```

It prints a summary and saves `backend\reports\FillPilot-team-report_<from>_to_<to>.csv`.

It is counts only, built from what is already recorded (`BILLS_READ` in
`audit_logs`, `fill_sessions`) — no patient names, amounts or values
(`GET /api/reports/team`, `routes/reports.routes.js`). It counts work done
through the extension with each person's own sign-in; the standalone package
below has no server and is not counted.

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

**Bill reading accuracy** (Yashoda bills → TGNPDCL claim), measured on real bills:

1. Put each patient's final bill and summary bill PDFs in their own folder:
   `backend\test-fixtures\bills\<case name>\` (any file names).
2. `npm.cmd run bill-accuracy -- draft` writes `expected.draft.json` in every
   folder that has no `expected.json` yet: what FillPilot read.
3. Check every value in it against the paper bill. Fix the wrong ones, add the
   rows it missed, delete rows that are not on the bill, then rename the file to
   `expected.json`.
4. `npm.cmd run bill-accuracy` reads every case again and reports how many
   values came out right: per case (with each wrong, missing or extra value)
   and overall (patient, totals, room, doctors, investigations).

Run step 4 after every change to the reading code. A fix that helps one bill
and breaks another shows up straight away.

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

# TotalShield Opportunity Folder Automation

Source for the Google Apps Script project **TotalShield Drive Management**
(owner adam@totalshield.com). It keeps one Google Drive folder per Copper
opportunity in the CRM shared drive, names and files it by lifecycle, and
scores how completely each finished project's folder is documented.

- Creates `YYYYMMDD_PRODUCT_Company_Opportunity_ID-<oid>` folders with the
  standard numbered subfolders, and writes the folder link back to Copper.
- Renames and moves folders between OPPORTUNITIES, PRODUCTION,
  CLOSED_PROJECTS and LOST as Copper records change (5-minute poll, nightly
  2 AM reconcile).
- Scores documentation completeness (0-100), writes it to Copper and drops a
  `_FILE DIRECTORY AND SCORING` report doc in each folder (nightly 3 AM, plus
  the RE-RUN web app and File Bot's on-demand call).
- Mirrors the Copper Production pipeline onto a shared calendar
  (`Calendar.gs`).
- Moves a Production opportunity from "Product Shipped" to "Send 2nd Invoice"
  once it has sat there 7 days (`StageTimers.gs`, daily 6 AM trigger; the
  age is Copper's own stage-change timestamp, so a record moved back by hand
  gets a fresh 7 days). Rules live in `STAGE_TIMERS`.

Install, triggers and operations: [SETUP.md](SETUP.md). The full history,
decisions and Drive/Copper IDs are in the Obsidian vault note
"Opportunity Folder Automation".

## Where the live code is

The Apps Script project is what actually runs:
https://script.google.com/home/projects/1k9PzQpvG4p9BeuJMPUNhvd2yZDm6ZZlt9IBiJCormjk2G0UAGnWMgUyr/edit

This repository was seeded on 15 October 2026 from a Drive export of that
project; every file matched the editor byte for byte. `Code.gs` in the editor
is `Config.gs` here. The repository does not deploy itself: after changing a
file here, paste it into the editor (or push with `clasp`), save, and move the
two deployments (RE-RUN web app and the File Bot API executable) to a new
version. If someone edits the project in the editor, copy the change back here.

Secrets (Copper API key, webhook secret, web app URL) live in Script
Properties and are never in this code.

## Tests

`node test/naming.test.js` runs the pure naming and scoring functions from
`Config.gs`, `Naming.gs`, `Scoring.gs` and `Placement.gs` under Node.
`node test/gates.test.js` tests the documentation stage gates (`Gates.gs`); see
[docs/GATES-PLAN.md](docs/GATES-PLAN.md).

# TotalShield Opportunity Folder Automation (Apps Script)

Replaces the Zapier zap "Copper CRM -> Create Google Drive Folder on New Opportunity" with a single Apps Script project that runs inside the TotalShield Google Workspace.

## What it does

1. New opportunity in Copper -> creates `YYYYMMDD_PRODUCT_Company Name_Opportunity Name_ID-12345678` in CRM > OPPORTUNITIES with the 12 standard subfolders, and writes Root ID, Link and Opportunity ID back to Copper.
2. Opportunity or Company edited in Copper -> folder renamed to match, and moved between CRM > OPPORTUNITIES / PRODUCTION / CLOSED_PROJECTS / LOST according to status and pipeline (Copper is the source of truth; the Copper ID in the folder name and in the Root ID field is the anchor).
3. Nightly reconciliation -> every Copper opportunity checked against Drive; mismatches fixed, missing subfolders added, orphan folders listed (never deleted).
4. Record enters Closed Projects -> documentation score computed from what staff filed in the subfolders and written to Copper plus a log sheet; recomputed at stage "Project Complete" or when "Project Completed (Archive)" is ticked.
5. Sync runs on a 5 minute poll of recently modified Copper records (webhooks are optional; see note below).

## Files

| File | Purpose |
|---|---|
| `Config.gs` | All settings: folder ID, product codes, subfolders, scoring rubric |
| `Copper.gs` | Copper API client (auth, search, custom fields, webhooks) |
| `Naming.gs` | Pure naming logic (unit tested in `test/naming.test.js`) |
| `Folders.gs` | Drive operations and per-opportunity sync |
| `Placement.gs` | Which top-level bucket a folder belongs in; scoring policy |
| `Handlers.gs` | Webhook receiver (`doPost`), polling, log sheet |
| `Reconcile.gs` | Dry-run plan and bulk rename of existing folders (resumable) |
| `Scoring.gs` | Documentation score |
| `StageTimers.gs` | Timed stage moves (Product Shipped -> Send 2nd Invoice after 7 days) |
| `Setup.gs` | Install helpers |
| `appsscript.json` | Manifest (scopes, web app settings) |

## Install (about 20 minutes)

1. Signed in as adam@totalshield.com, open https://script.google.com and create a new project named "TS Opportunity Folders". In Project Settings tick "Show appsscript.json in editor".
2. Create one script file per `.gs` file above and paste the contents; replace `appsscript.json` with the one supplied.
3. In Drive, create PRODUCTION, CLOSED_PROJECTS and LOST next to OPPORTUNITIES in the CRM shared drive and paste their folder IDs (from the URL) into `CONFIG.BUCKETS` in `Config.gs`.
4. In Copper: Settings > Integrations > API Keys, generate a key. In Copper Fields On Records, create a Number field named **Opportunity Documentation Score** on Pipeline Records (needed for scoring only).
5. In `Config.gs`, put the API key into `setSecrets()`, run `setSecrets` once from the editor (authorize when prompted), then delete the key from the code.
6. Run `checkSetup` and read the log (View > Logs / Executions). Every custom field should say OK and every dropdown option should show a code.
7. Run `testOneOpportunity`. It prints the name the Bay Advanced Technologies folder would get, without changing anything.
8. Run `installPollTrigger` (5 minute poll). Do not install the nightly reconcile until the migration has been reviewed and executed; then run `installNightlyTrigger`. Run `advanceAgedStagesDryRun` and read the log, then `installStageTimerTrigger` (daily 6 AM stage mover).
9. Optional webhooks (only if the Workspace allows web apps with access "Anyone"; TotalShield's policy currently does not): Deploy > New deployment > Web app (Execute as Me, Anyone), then `registerWebhooks('PASTE_EXEC_URL')`.
10. Parallel run: with the Zap still on, create a throwaway opportunity and confirm the script renames the Zap's folder rather than duplicating it. `CONFIG.SYNC_CREATED_AFTER` limits the poll to records created after a timestamp so existing folders are untouched during this phase.
11. Turn the Zapier zap **off**. Create a test opportunity in Copper and confirm the folder appears within a minute with all subfolders and the link on the record.

## Migrating the existing folders

0. Lost/Abandoned first (done 26 Aug 2026): `reconcileLostDryRun` then `reconcileLostExecute`. These rename and move to LOST without creating subfolders (`SUBFOLDERS_FOR_LOST: false`) and never create a folder for a lost record that has none (`CREATE_FOLDERS_FOR_LOST: false`).
1. Run `reconcileDryRun`. It works through all ~810 opportunities in 5 minute chunks (it reschedules itself), then writes a **Reconcile Plan** sheet in the log spreadsheet ("TS Opportunity Folder Automation Log" in the CRM shared drive) with current name, proposed name and action for every folder, plus an `orphan` row for each folder with no Copper record.
2. Review the sheet. Company names come from the Copper Company record, so fix the company in Copper (not in Drive) for any that look wrong, then rerun the dry run.
3. Run `reconcileExecute`. Renames are done by folder ID, so links people already have keep working. Subfolders are added to every folder.
4. Orphans stay where they are. Decide manually whether to attach them to an opportunity (rename them to end in `_ID-<copper id>` and the next nightly run adopts them) or move them to ARCHIVE.

## Company name consistency

The Zap read the company name out of the trigger payload, which was often empty and never re-synced. This script always fetches the Company record by `company_id`, normalises it (`normalizeCompany_`: trims, collapses whitespace, strips Inc/LLC/Ltd/Corp/GmbH/AS etc. so "Acme Cryogenics, Inc." and "Acme Cryogenics" are the same company), and re-applies it on every Copper change and every night. The Company record in Copper is therefore the one place to fix a name. If you also want to catch duplicate Company records in Copper, `companyKey_` gives a comparison key; a report of companies sharing a key is a five line addition.

## Scoring rubric

Edit `CONFIG.SCORING` in `Config.gs`. Each subfolder has a `weight` (points), `minFiles` for full credit, and `required`. Files left loose at the folder root cost 2 points each, capped at 10. The score is normalised to 0-100 and written to the Copper field plus the "score" sheet with a per-folder breakdown, so you can build a Copper report or a Looker Studio view by owner, product type, or month.

Trigger: entry to the Closed Projects pipeline, with a final recompute at stage "Project Complete" or the "Project Completed (Archive)" checkbox. `scoreAllCompleted` scores historical completed records in one go; `scoreOpportunityById(id)` rescores one.

## Notes and limits

- If webhooks are ever enabled: Apps Script web apps answer with an HTTP redirect before the JSON body; Copper accepts this in practice, and the poll covers any delivery that does not land.
- Apps Script runs a function for at most 6 minutes; the reconcile is chunked and resumes automatically. `resetReconcileState` abandons a stuck run.
- Drive quota: ~800 renames plus ~9,600 subfolder creations is well inside the daily limits but the first execute will take roughly an hour of chunked runs.
- Nothing is ever deleted by this script. Folders are only moved between the four configured buckets, and only when `ENABLE_MOVES` is true.
- Editor gotchas: the function picker runs the first item if its menu is still open when you click Run (select, press Escape, verify the label, then Run, and confirm on the Executions page); navigating the editor tab away cancels an editor-launched run.
- To change the name layout, edit `buildFolderName_` in `Naming.gs` (or set `INCLUDE_OPP_NAME: false` to drop the opportunity name) and run `node test/naming.test.js` to check.

# Documentation Stage Gates: Plan for Adam (rev 3, 15 Oct 2026)

**Status:** draft. Nothing is live. The code sits uncommitted in `/workspace/gates/repo` (based on `acrossi/totalshield-opp-folders` @ `e9eec57`). Diff: `gates.diff`.

Copper cannot refuse a stage change. Each handoff workflow gets one extra condition on a checkbox that only this script ticks, and only once the Drive folder has the required files. A deal that fails a gate stays at its handoff stage. Nothing is ever moved backward.

## Final gates (editable in `CONFIG.GATES`)

| Gate | Handoff stage (where deals park) | Copper move it controls | Required folder credit |
|---|---|---|---|
| **Production** | Sales: `Initial Down Payment Received` (4424598) | Workflow A to Production / `Production Initiation` | **02_REQUIREMENTS, 04_MODEL (SolidWorks + PDF), 05_QUOTE, 06_PURCHASE_ORDER**. 00, 01, 03 are *recommended*: they appear in the nudges but don't block |
| **Close** | Production: `Customer Installation Support` (4394767), the final Production stage | Workflow B to Closed Projects / `All Payments Received` (5191147) | **02, 03, 04, 05, 06, 08**, plus **09_INSTALLATION for installed jobs**. 00, 01 are *recommended* (in nudges, don't block) |
| **Complete** (hard) | Closed: `Folder Review` (5191144) | Workflow C to `Project Complete` (5191140) | **100/100** (all nine weighted folders, including 10_FINANCIALS) |

Flow at Close: the deal waits in `Waiting on 2nd Payment` until Carin confirms payment. It then moves to the final Production stage, and that stage's workflow moves it to Closed Projects. The gate is checked at that last step.

**Confirm in Copper:** the live stage order puts `Customer Installation Support` last, after `Waiting on 2nd Payment` and `Active Installation`. The notes say its workflow moves the deal to Closed Projects (an older note said "Project Complete" or "Completed Product to Finalized Sale"). Please open Settings > Workflow Automation and confirm (a) the trigger stage is `Customer Installation Support` and (b) the target is `Closed Projects / All Payments Received`. If the trigger is a different stage, change `handoffStage` for `close` in Config.

### What counts as "installed"
A job counts as installed if **either**:
1. a new Copper checkbox **`Installed by TotalShield`** is ticked (the reliable signal; recommended), **or**
2. the script ever saw the deal at **`Active Installation`** (remembered per deal).

`Customer Installation Support` alone does **not** count, because every job passes through it on the way to Closed. **Assumption:** installed jobs go through `Active Installation`. A job that jumps straight to the final stage is only caught if the checkbox is ticked. Tell the team to tick it when the order is booked.

## Copper setup (Adam)

1. **Create Checkbox fields** on Opportunities: `Docs OK for Production`, `Docs OK for Close`, `Docs OK for Complete`, `Gate Override`, `Installed by TotalShield`.
2. **Workflow A** (stage `Initial Down Payment Received` to Production): add the condition *Docs OK for Production is checked OR Gate Override is checked*.
3. **Workflow B** (final Production stage to Closed / All Payments Received): add *Docs OK for Close OR Gate Override*.
4. **Workflow C (new, hard gate):** trigger = opportunity updated, stage = `Folder Review`, *Docs OK for Complete OR Gate Override* checked; action = set stage to `Project Complete`. Tell the team to never pick Project Complete by hand. If they do, the script logs it as a bypass (Copper can't block the dropdown).

## Gate Override: Adam Rossi, Carin Charon, Isabel Silva only
Copper user IDs: Adam 984268, Carin 991740, Isabel Silva 993457 (`OVERRIDE_ALLOWED_USERS`).

**Limitation:** Copper's API does not say *who* ticked a field, so the script can't verify the setter. As far as I know, Copper also has no per-field edit permissions (please confirm in your plan's field settings). The draft therefore:
- **honors** the override (otherwise urgent deals can't move),
- logs every override as `override_unverified` in the `gate` log tab, with the deal's assignee and the last-modified time,
- lets Hanibal post each new override to `#crm-bot`, so any override not set by Adam, Carin or Isabel is visible the same day.

**Stricter alternatives** if you want them:
- Hide the field from everyone else, if Copper's field visibility allows it.
- Use a Copper workflow to email Adam whenever Gate Override changes.

## No grandfathering: impact
Deals already in flight have to pass each gate at their **next** handoff. The 30 Aug baseline had essentially every active folder at about 0, so once the workflow conditions go live, **expect most deals reaching a handoff to park**, especially at Close (02–06 + 08) and Complete (100/100). A box ticked after a deal legitimately passed is never cleared later.

**Strongly recommended:** run 2–3 weeks with `ENABLE: true, WARN_ONLY: true` and the workflows unchanged. The Parked tab and nudges then show exactly who would be blocked, and people can file their documents *before* anything is enforced.

## Parked-deal nudges (Hanibal)
- Every 15 minutes the poll runs `sweepParkedDeals()`. It re-checks every open deal sitting at a handoff stage, ticks the box as soon as the files are there, and **rewrites the `Parked` tab** in the "TS Opportunity Folder Automation Log" sheet.
- **Parked tab columns:** opp_id, opportunity, owner, owner_email, gate, stage, missing_required, missing_recommended, folder, copper, first_parked, last_checked.
- **Hanibal reads that tab** on a routine and posts:
  - a summary to **`#crm-bot`**,
  - a **DM to each owner** listing what's missing and the folder link.
- The script itself never posts to Slack. The parked list also fills during warn-only mode.

## Rollout
1. Paste the code into the project (or use `clasp`) with `ENABLE: false`. Create the 5 Copper fields.
2. `ENABLE: true`, `WARN_ONLY: true` for 2–3 weeks. Nudges start; review the `gate` and `Parked` tabs.
3. `WARN_ONLY: false`, so the script writes the Docs OK boxes. Run the tests below on a throwaway deal.
4. Add the conditions to Workflow A, then B, then create C. Do one at a time, each with a test deal.

## Test plan
| # | Test | Pass |
|---|---|---|
| 1 | `node test/naming.test.js`, `node test/gates.test.js` | ALL PASS |
| 2 | Test deal at `Initial Down Payment Received` with only 02/04/05/06 filed | Docs OK for Production ticked; 00/01/03 listed as recommended |
| 3 | **Re-trigger (critical):** Workflow A live, deal parked, then file the missing doc | The next sweep ticks the box and Copper moves the deal to Production with no manual step. If the workflow doesn't fire on an API checkbox update, stop and pick a fallback (manager advances it after the Slack nudge, or ask Copper support) |
| 4 | Missing PO at the handoff | Deal stays in Sales and appears in the Parked tab |
| 5 | Installed job (checkbox or Active Installation) without 09 at the final stage | Close fails, 09 is listed |
| 6 | Non-installed job without 09 | Close passes |
| 7 | Deal at Folder Review below 100 | Stays; Workflow C does not fire |
| 8 | Gate Override ticked | Boxes ticked; `override_unverified` row logged |
| 9 | Pipeline dropdown changed by hand | `bypass` row logged; deal is not moved back |

## Risks
- **Workflow re-trigger on API update is unproven.** Test 3 must pass before enforcing.
- **Override setter can't be verified.** Mitigated by logging plus Hanibal's audit post.
- **Installed-job detection depends on `Active Installation` or the checkbox.**
- **Many parked deals at first** (no grandfathering). Mitigated by the warn-only period.
- **Load:** the sweep inventories every parked folder every 15 minutes. That's fine at today's volume. If it slows down, raise the interval.

## Decided (15 Oct)
- Gate Override: honor + log `override_unverified` + Hanibal posts each one to #crm-bot. **Resolved.**
- Field names approved: Docs OK for Production / Close / Complete, Gate Override, Installed by TotalShield. **Resolved.**
- Close gate: required 02, 03, 04, 05, 06, 08 (+09 if installed); 00, 01 recommended only. **Resolved.**

## Still to confirm
1. The trigger stage and target of the Production to Closed workflow (see above).
2. Whether Copper can restrict who edits `Gate Override` (nice to have; logging is the accepted control).
3. Copper workflow re-fires when only the API ticks a checkbox (test 3) before any enforcement.

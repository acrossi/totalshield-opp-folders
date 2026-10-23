/**
 * StageTimers.gs - moves an opportunity to the next stage once it has sat in a
 * stage for a set number of days, and shows the planned date on the record.
 *
 * Rule (Adam, 23 October 2026): a Production opportunity in "Product Shipped"
 * moves to "Send 2nd Invoice" after 7 days. Copper's own workflow automation
 * cannot wait, so this runs daily from a time trigger (installStageTimerTrigger).
 *
 * The age comes from Copper's date_stage_changed on the record, so a record
 * moved back into the stage by hand gets a fresh 7 days. Lost and Abandoned
 * records are left alone. Every move is logged to the 'stage_timer' sheet of the log
 * spreadsheet; advanceAgedStagesDryRun logs what would move without moving it.
 *
 * The "Auto-advance on" Date field (createAutoAdvanceField) holds the day a
 * record will move. The daily run fills it for every record in a timed stage
 * and clears it as part of the move; the 5-minute poll (syncAutoAdvanceField_)
 * fills or clears it within minutes of a hand move in or out of the stage.
 */

var STAGE_TIMERS = [
  { pipeline: 'Production', from: 'Product Shipped', to: 'Send 2nd Invoice', afterDays: 7 }
];

var AUTO_ADVANCE_FIELD = 'Auto-advance on';   // Date custom field on opportunities

function advanceAgedStages() { return advanceAgedStages_({ dryRun: false }); }
function advanceAgedStagesDryRun() { return advanceAgedStages_({ dryRun: true }); }

function advanceAgedStages_(opts) {
  opts = opts || {};
  // No script lock: the 5-minute poll holds it for minutes at a time, and this
  // job only reads Copper and changes a stage, which the poll can run alongside.
  var moved = [], dated = 0;
  var pipelines = copperPipelines_().byName;
  var hasField = !!copperFieldDefs_().byName[AUTO_ADVANCE_FIELD];
  var now = Math.floor(Date.now() / 1000);
  STAGE_TIMERS.forEach(function (rule) {
    var pl = pipelines[rule.pipeline];
    if (!pl) throw new Error('Pipeline not found: ' + rule.pipeline);
    var from = stageByName_(pl, rule.from), to = stageByName_(pl, rule.to);
    var cutoff = now - rule.afterDays * 86400;
    var opps = copperSearchOpportunities_({ pipeline_ids: [pl.id], pipeline_stage_ids: [from.id] }, 5);
    opps.forEach(function (o) {
      // Production records are normally status Won; only skip dead ones.
      if (o.status === 'Lost' || o.status === 'Abandoned') return;
      if (o.pipeline_stage_id !== from.id) return;
      if (!o.date_stage_changed) {
        logRow_('error', [o.id, 'stage_timer', 'no date_stage_changed on record']);
        return;
      }
      if (o.date_stage_changed > cutoff) {
        // Not due yet: keep the planned date on the record.
        try { if (hasField && !opts.dryRun && syncAutoAdvanceField_(o)) dated++; }
        catch (e) { logRow_('error', [o.id, 'stage_timer date', String(e)]); }
        return;
      }
      var days = Math.floor((now - o.date_stage_changed) / 86400);
      var line = [o.id, o.name, rule.from, rule.to, days, opts.dryRun ? 'dry-run' : 'moved'];
      try {
        if (!opts.dryRun) {
          var body = { pipeline_stage_id: to.id };
          if (hasField) body.custom_fields = autoAdvanceFields_(null);   // clear the date in the same write
          copperUpdateOpportunity_(o.id, body);
        }
        logRow_('stage_timer', line);
        moved.push(line);
        Logger.log(line.join(' | '));
      } catch (e) {
        logRow_('error', [o.id, 'stage_timer', String(e)]);
      }
    });
    // Records that left the stage by hand: clear a stale date. The poll normally
    // does this within minutes; this is the daily safety net for the pipeline.
    if (hasField && !opts.dryRun) {
      copperSearchOpportunities_({ pipeline_ids: [pl.id] }, 10).forEach(function (o) {
        if (o.pipeline_stage_id === from.id) return;
        try { if (syncAutoAdvanceField_(o)) dated++; }
        catch (e) { logRow_('error', [o.id, 'stage_timer date', String(e)]); }
      });
    }
  });
  logRow_('poll', ['stage_timer' + (opts.dryRun ? ' dry-run' : ''), moved.length, dated]);
  Logger.log((opts.dryRun ? 'Would move ' : 'Moved ') + moved.length + ' opportunit' + (moved.length === 1 ? 'y' : 'ies')
    + (opts.dryRun ? '' : '; ' + dated + ' auto-advance date' + (dated === 1 ? '' : 's') + ' updated'));
  return moved;
}

function stageByName_(pipeline, name) {
  var s = (pipeline.stages || []).filter(function (x) { return x.name === name; })[0];
  if (!s) throw new Error('Stage not found in ' + pipeline.name + ': ' + name);
  return s;
}

/* ---------------- "Auto-advance on" date field ---------------- */

/**
 * The day a record will auto-advance, as unix seconds at noon in CONFIG.TIMEZONE,
 * or null when no timer applies to it (wrong stage, Lost/Abandoned, no stage date).
 */
function autoAdvanceDue_(o) {
  if (o.status === 'Lost' || o.status === 'Abandoned') return null;
  var pl = copperPipelines_().byId[o.pipeline_id];
  if (!pl) return null;
  for (var i = 0; i < STAGE_TIMERS.length; i++) {
    var rule = STAGE_TIMERS[i];
    if (rule.pipeline !== pl.name) continue;
    var from = (pl.stages || []).filter(function (s) { return s.name === rule.from; })[0];
    if (!from || o.pipeline_stage_id !== from.id) continue;
    if (!o.date_stage_changed) return null;
    var d = calParseDate_(o.date_stage_changed + rule.afterDays * 86400);   // noon, calendar day in CONFIG.TIMEZONE
    return d ? Math.floor(d.getTime() / 1000) : null;
  }
  return null;
}

/** Build the custom_fields array that sets (unix seconds) or clears (null) the date field. */
function autoAdvanceFields_(value) {
  return copperCustomFields_((function () { var m = {}; m[AUTO_ADVANCE_FIELD] = value; return m; })());
}

/**
 * Make the record's "Auto-advance on" field match what the timers say.
 * Writes only when the calendar day differs. Returns true when it wrote.
 * Safe to call from the poll on any record; a no-op while the field does not exist.
 */
function syncAutoAdvanceField_(o) {
  if (!copperFieldDefs_().byName[AUTO_ADVANCE_FIELD]) return false;
  var want = autoAdvanceDue_(o);
  var have = copperFieldValue_(o, AUTO_ADVANCE_FIELD);
  if (calDateStr_(calParseDate_(have)) === calDateStr_(want ? calParseDate_(want) : null)) return false;
  copperUpdateOpportunity_(o.id, { custom_fields: autoAdvanceFields_(want) });
  logRow_('stage_timer', [o.id, o.name, '', '', '', want ? 'date set ' + calDateStr_(calParseDate_(want)) : 'date cleared']);
  return true;
}

/** One-off: create the "Auto-advance on" Date field on opportunities, if it does not exist. */
function createAutoAdvanceField() {
  var defs = copperFieldDefs_().byName;
  if (defs[AUTO_ADVANCE_FIELD]) { Logger.log('Already exists: id ' + defs[AUTO_ADVANCE_FIELD].id); return; }
  var made = copperRequest_('POST', '/custom_field_definitions', {
    name: AUTO_ADVANCE_FIELD, data_type: 'Date', available_on: ['opportunity']
  });
  clearCaches();
  Logger.log('Created: ' + JSON.stringify(made));
}

/**
 * Round trip the date field on one record: set it to a date, read it back,
 * clear it, read it back. Logs both reads. Use once after creating the field to
 * confirm Copper's write and clear formats; touches nothing but that field.
 */
function testAutoAdvanceFieldWrite(oppId) {
  oppId = oppId || 38903151;
  var when = Math.floor(calParseDate_(Math.floor(Date.now() / 1000) + 7 * 86400).getTime() / 1000);
  copperUpdateOpportunity_(oppId, { custom_fields: autoAdvanceFields_(when) });
  var after = copperFieldValue_(copperGetOpportunity_(oppId), AUTO_ADVANCE_FIELD);
  Logger.log('set ' + when + ' -> read back ' + JSON.stringify(after) + ' (' + calDateStr_(calParseDate_(after)) + ')');
  copperUpdateOpportunity_(oppId, { custom_fields: autoAdvanceFields_(null) });
  var cleared = copperFieldValue_(copperGetOpportunity_(oppId), AUTO_ADVANCE_FIELD);
  Logger.log('cleared -> read back ' + JSON.stringify(cleared));
}

/** Daily trigger, 6 AM in CONFIG.TIMEZONE. Safe to re-run; replaces any existing one. */
function installStageTimerTrigger() {
  deleteTriggersFor_('advanceAgedStages');
  ScriptApp.newTrigger('advanceAgedStages').timeBased().atHour(6).everyDays(1).inTimezone(CONFIG.TIMEZONE).create();
  Logger.log('Stage timer trigger installed (daily 6 AM ' + CONFIG.TIMEZONE + ')');
}

/**
 * StageTimers.gs - moves an opportunity to the next stage once it has sat in a
 * stage for a set number of days.
 *
 * Rule (Adam, 23 October 2026): a Production opportunity in "Product Shipped"
 * moves to "Send 2nd Invoice" after 7 days. Copper's own workflow automation
 * cannot wait, so this runs daily from a time trigger (installStageTimerTrigger).
 *
 * The age comes from Copper's date_stage_changed on the record, so a record
 * moved back into the stage by hand gets a fresh 7 days. Lost and Abandoned
 * records are left alone. Every move is logged to the 'stage_timer' sheet of the log
 * spreadsheet; advanceAgedStagesDryRun logs what would move without moving it.
 */

var STAGE_TIMERS = [
  { pipeline: 'Production', from: 'Product Shipped', to: 'Send 2nd Invoice', afterDays: 7 }
];

function advanceAgedStages() { return advanceAgedStages_({ dryRun: false }); }
function advanceAgedStagesDryRun() { return advanceAgedStages_({ dryRun: true }); }

function advanceAgedStages_(opts) {
  opts = opts || {};
  // No script lock: the 5-minute poll holds it for minutes at a time, and this
  // job only reads Copper and changes a stage, which the poll can run alongside.
  var moved = [];
  {
    var pipelines = copperPipelines_().byName;
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
        if (o.date_stage_changed > cutoff) return;
        var days = Math.floor((now - o.date_stage_changed) / 86400);
        var line = [o.id, o.name, rule.from, rule.to, days, opts.dryRun ? 'dry-run' : 'moved'];
        try {
          if (!opts.dryRun) copperUpdateOpportunity_(o.id, { pipeline_stage_id: to.id });
          logRow_('stage_timer', line);
          moved.push(line);
          Logger.log(line.join(' | '));
        } catch (e) {
          logRow_('error', [o.id, 'stage_timer', String(e)]);
        }
      });
    });
    logRow_('poll', ['stage_timer' + (opts.dryRun ? ' dry-run' : ''), moved.length]);
  }
  Logger.log((opts.dryRun ? 'Would move ' : 'Moved ') + moved.length + ' opportunit' + (moved.length === 1 ? 'y' : 'ies'));
  return moved;
}

function stageByName_(pipeline, name) {
  var s = (pipeline.stages || []).filter(function (x) { return x.name === name; })[0];
  if (!s) throw new Error('Stage not found in ' + pipeline.name + ': ' + name);
  return s;
}

/** Daily trigger, 6 AM in CONFIG.TIMEZONE. Safe to re-run; replaces any existing one. */
function installStageTimerTrigger() {
  deleteTriggersFor_('advanceAgedStages');
  ScriptApp.newTrigger('advanceAgedStages').timeBased().atHour(6).everyDays(1).inTimezone(CONFIG.TIMEZONE).create();
  Logger.log('Stage timer trigger installed (daily 6 AM ' + CONFIG.TIMEZONE + ')');
}

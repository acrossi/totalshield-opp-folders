/**
 * Setup.gs - one-time installation helpers. Run from the Apps Script editor in this order:
 *
 *   1. setSecrets()            (Config.gs) after pasting the Copper API key, then blank it out again
 *   2. checkSetup()             verifies Drive folder, Copper auth, custom fields
 *   3. installPollTrigger()     5-min poll (webhooks optional, see registerWebhooks)
 *   4. Test with a throwaway opportunity in Copper, then turn the Zapier zap OFF
 *   5. reconcileDryRun()        review the "Reconcile Plan" sheet
 *   6. reconcileExecute()       apply
 *   7. installNightlyTrigger()  2 AM reconcile
 */

function checkSetup() {
  var out = [];
  Object.keys(CONFIG.BUCKETS).forEach(function (k) {
    var f = bucketFolder_(k);
    out.push((f ? 'OK   ' : 'MISSING ') + 'bucket ' + k + (f ? ' -> ' + f.getName() : ' (no folder ID in CONFIG.BUCKETS)'));
  });
  var pl = copperPipelines_().byName;
  [CONFIG.PIPELINE_SALES, CONFIG.PIPELINE_PRODUCTION, CONFIG.PIPELINE_CLOSED].forEach(function (n) {
    out.push((pl[n] ? 'OK   ' : 'MISSING ') + 'pipeline ' + n + (pl[n] ? ' (id ' + pl[n].id + ', ' + pl[n].stages.length + ' stages)' : ''));
  });
  var defs = copperFieldDefs_().byName;
  [CONFIG.CF_DRIVE_ROOT_ID, CONFIG.CF_DRIVE_LINK, CONFIG.CF_OPP_ID, CONFIG.CF_PRODUCT_TYPE, CONFIG.CF_PROJECT_COMPLETED, CONFIG.CF_DOC_SCORE]
    .forEach(function (l) { out.push((defs[l] ? 'OK   ' : 'MISSING ') + l + (defs[l] ? ' (' + defs[l].data_type + ', id ' + defs[l].id + ')' : '')); });
  var pt = defs[CONFIG.CF_PRODUCT_TYPE];
  if (pt && pt.options) {
    pt.options.forEach(function (o) {
      out.push((CONFIG.PRODUCT_CODES[o.name] ? 'code ' + CONFIG.PRODUCT_CODES[o.name] : 'NO CODE') + '  <- ' + o.name);
    });
  }
  out.push('Log sheet: ' + logSpreadsheet_().getUrl());
  var sample = copperSearchOpportunities_({}, 1)[0];
  if (sample) out.push('Sample name: ' + buildFolderName_(oppNamingInput_(sample)));
  Logger.log(out.join('\n'));
  return out;
}

function registerWebhooks(webAppUrl) {
  if (!webAppUrl) throw new Error('Pass the deployed Web App /exec URL');
  var existing = copperListWebhooks_();
  existing.forEach(function (w) { if (w.target === webAppUrl) copperDeleteWebhook_(w.id); });
  var made = [
    copperCreateWebhook_(webAppUrl, 'opportunity', 'new'),
    copperCreateWebhook_(webAppUrl, 'opportunity', 'update'),
    copperCreateWebhook_(webAppUrl, 'company', 'update')
  ];
  Logger.log(JSON.stringify(made, null, 2));
}

function listWebhooks() { Logger.log(JSON.stringify(copperListWebhooks_(), null, 2)); }

/** Poll trigger only. Safe to install before the migration. */
function installPollTrigger() {
  deleteTriggersFor_('pollRecentOpportunities');
  ScriptApp.newTrigger('pollRecentOpportunities').timeBased().everyMinutes(CONFIG.POLL_EVERY_MINUTES).create();
  Logger.log('Poll trigger installed (every ' + CONFIG.POLL_EVERY_MINUTES + ' min)');
}

/** Nightly reconcile. Install only AFTER reconcileExecute has been reviewed and run. */
function installNightlyTrigger() {
  deleteTriggersFor_('reconcileNightly');
  var t = ScriptApp.newTrigger('reconcileNightly').timeBased().atHour(2).everyDays(1).inTimezone(CONFIG.TIMEZONE).create();
  PropertiesService.getScriptProperties().setProperty('NIGHTLY_TRIGGER_ID', t.getUniqueId());
  Logger.log('Nightly reconcile trigger installed (2 AM ' + CONFIG.TIMEZONE + ')');
}

function installTriggers() { installPollTrigger(); installNightlyTrigger(); }

function deleteTriggersFor_(fn) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); });
}

/** Drop cached Copper field definitions, pipelines and the folder index (after changing dropdown options in Copper). */
function clearCaches() {
  CacheService.getScriptCache().removeAll(['cfdefs', 'pipelines', 'folderIndex']);
  Logger.log('Caches cleared');
}

/** One-off data fix: set "Primary Product Type of Interest" on records that were left as Other / Unknown. */
function fixProductTypes() {
  var fixes = {
    38440884: 'Mobile Shield Enclosure',      // Bickley Engineers - Mobile Shielded Enclosure
    36809114: 'Replacement Parts',            // Kobelco - Custom Plates
    36774556: 'Replacement Parts',            // XNRGY - Polycarbonate Panels Order
    36517623: 'Replacement Parts',            // 1s1 Energy - Custom Plate
    33075287: 'Replacement Parts',            // Lockheed Martin - Custom Bracket - Mega Shield Room
    32652690: 'Replacement Parts',            // SpaceX - Blast Door
    30907558: 'Replacement Parts',            // SpaceX - Camera Covers
    30880999: 'Replacement Parts',            // Panthalassa - Single Poly Panel
    29583779: 'Heat Exchanger Test Shield',   // A11 Supply - HETShield for ExxonMobil
    27011368: 'Replacement Parts'             // Woodward - Poly Replacement Panels
  };
  var def = copperFieldDefs_().byName[CONFIG.CF_PRODUCT_TYPE];
  Object.keys(fixes).forEach(function (id) {
    var opt = (def.options || []).filter(function (o) { return o.name === fixes[id]; })[0];
    if (!opt) { Logger.log(id + ': option not found "' + fixes[id] + '"'); return; }
    copperUpdateOpportunity_(Number(id), { custom_fields: [{ custom_field_definition_id: def.id, value: opt.id }] });
    Logger.log(id + ' -> ' + fixes[id]);
  });
}

/** One-off: create the "Opportunity Documentation Score" Number field on opportunities, if it does not exist. */
function createScoreField() {
  var defs = copperFieldDefs_().byName;
  if (defs[CONFIG.CF_DOC_SCORE]) { Logger.log('Already exists: id ' + defs[CONFIG.CF_DOC_SCORE].id); return; }
  var made = copperRequest_('POST', '/custom_field_definitions', {
    name: CONFIG.CF_DOC_SCORE,
    data_type: 'Float',
    available_on: ['opportunity']
  });
  clearCaches();
  Logger.log('Created: ' + JSON.stringify(made));
}

function listTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { Logger.log(t.getHandlerFunction() + ' : ' + t.getEventType()); });
}

/** Try the whole flow on one opportunity without touching anything else. */
function testOneOpportunity() {
  var id = 38973969; // Bay Advanced Technologies - Benchtop Enclosure
  var opp = copperGetOpportunity_(id);
  Logger.log('Would name: ' + buildFolderName_(oppNamingInput_(opp)));
  Logger.log(JSON.stringify(syncOpportunity_(opp, { dryRun: true })));
}

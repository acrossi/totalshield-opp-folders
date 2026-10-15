/**
 * Handlers.gs - entry points: Copper webhook (doPost), polling safety net, logging.
 */

/** Copper webhook receiver. Deploy as Web App: Execute as Me, Access: Anyone. */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    if (!body.secret || body.secret.key !== getSecret_('WEBHOOK_SECRET')) {
      return jsonOut_({ ok: false, error: 'bad secret' });
    }
    lock.waitLock(30000);
    var ids = body.ids || [];
    var type = body.type, event = body.event;
    logRow_('webhook', [type, event, ids.join(','), JSON.stringify(body.updated_attributes || {}).slice(0, 500)]);

    if (type === 'opportunity' && (event === 'new' || event === 'update')) {
      ids.forEach(function (id) {
        try {
          var opp = copperGetOpportunity_(id);
          syncOpportunity_(opp);
          if (event === 'update') {
            // scoreOpportunity_ already applies gates; only run the gate pass when we did not score
            if (!maybeScore_(opp)) maybeApplyDocumentationGates_(opp);
          }
        } catch (err) { logRow_('error', [id, 'webhook ' + event, String(err)]); }
      });
    } else if (type === 'company' && event === 'update') {
      ids.forEach(function (id) { try { syncCompany_(id); } catch (err) { logRow_('error', [id, 'webhook company', String(err)]); } });
    }
    return jsonOut_({ ok: true, processed: ids.length });
  } catch (err) {
    logRow_('error', ['-', 'doPost', String(err)]);
    return jsonOut_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

/**
 * Web app GET. Deployed "execute as me / anyone within TotalShield" so any staff member can
 * click RE-RUN THIS CHECK in a score report. ?action=score&id=<oppId> regenerates the report.
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'score' && /^\d{5,}$/.test(String(p.id || ''))) {
    var out;
    try {
      var r = scoreAndReport(Number(p.id));
      out = r
        ? '<h1 style="font-size:48px;margin:24px 0 8px">' + r.score + ' / 100</h1>' +
          '<p style="font-size:18px">' + htmlEsc_(r.folder.getName()) + '</p>' +
          '<p>Owner: ' + htmlEsc_(r.owner.name) + '</p>' +
          (r.missing.length ? '<p><b>Still missing:</b></p><ul><li>' + r.missing.map(htmlEsc_).join('</li><li>') + '</li></ul>' : '<p><b>Nothing missing. Well filed.</b></p>') +
          '<p><a href="' + r.docUrl + '">Open the new file directory and scoring report</a> &nbsp;|&nbsp; <a href="' + r.folder.getUrl() + '">Open the folder</a></p>'
        : '<h1>No folder found for opportunity ' + Number(p.id) + '</h1>';
    } catch (err) {
      out = '<h1>Error</h1><p>' + htmlEsc_(String(err)) + '</p>';
    }
    return HtmlService.createHtmlOutput('<div style="font-family:Arial,sans-serif;max-width:640px;margin:40px auto">' + out + '</div>')
      .setTitle('TotalShield Documentation Score');
  }
  return jsonOut_({ ok: true, service: 'TotalShield opportunity folder automation' });
}

function htmlEsc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function jsonOut_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/**
 * Polling safety net, primary sync, run every POLL_EVERY_MINUTES by time trigger.
 * Syncs opportunities created or modified in the lookback window and scores any newly completed.
 */
function pollRecentOpportunities() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var since = Math.floor(Date.now() / 1000) - CONFIG.POLL_LOOKBACK_MINUTES * 60;
    var opps = copperSearchOpportunities_({ minimum_modified_date: since }, 5);
    var cache = {};
    opps.forEach(function (o) {
      if (CONFIG.SYNC_CREATED_AFTER && o.date_created < CONFIG.SYNC_CREATED_AFTER) return;
      try {
        syncOpportunity_(o, { companyCache: cache });
        if (shouldScore_(o) && !hasScore_(o)) scoreOpportunity_(o);
        else maybeApplyDocumentationGates_(o);
      } catch (e) { logRow_('error', [o.id, 'poll', String(e)]); }
    });
    logRow_('poll', ['synced', opps.length]);
    try { sweepParkedDeals(); } catch (e) { logRow_('error', ['-', 'parked sweep', String(e)]); }
  } finally { lock.releaseLock(); }
}

function hasScore_(opp) {
  var v = copperFieldValue_(opp, CONFIG.CF_DOC_SCORE);
  return v !== null && v !== undefined && v !== '';
}

/* ---------------- Logging to a Google Sheet ---------------- */

function logSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('LOG_SPREADSHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  var ss = SpreadsheetApp.create(CONFIG.LOG_SPREADSHEET_NAME);
  // move to the CRM shared drive root (parent of OPPORTUNITIES)
  try {
    var file = DriveApp.getFileById(ss.getId());
    var parent = oppRoot_().getParents().next();
    file.moveTo(parent);
  } catch (e) { Logger.log('Could not move log sheet: ' + e); }
  props.setProperty('LOG_SPREADSHEET_ID', ss.getId());
  return ss;
}

function logSheet_(name, headers) {
  var ss = logSpreadsheet_();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(['timestamp'].concat(headers)); sh.setFrozenRows(1); }
  return sh;
}

var LOG_HEADERS_ = {
  sync: ['opp_id', 'action', 'old_name', 'new_name', 'bucket_from>to', 'link', 'company'],
  webhook: ['type', 'event', 'ids', 'updated_attributes'],
  error: ['opp_id', 'where', 'error'],
  poll: ['what', 'count'],
  score: ['opp_id', 'folder', 'score', 'max', 'breakdown'],
  gate: ['opp_id', 'result', 'gate_key', 'pipeline', 'stage', 'detail']
};

function logRow_(kind, cells) {
  try {
    var sh = logSheet_(kind, LOG_HEADERS_[kind] || []);
    sh.appendRow([new Date()].concat(cells));
  } catch (e) { Logger.log('log failed: ' + e); }
}

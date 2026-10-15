/**
 * Calendar.gs - TotalShield Production Calendar.
 *
 * Mirrors the Copper "Production" pipeline onto a shared Google Calendar:
 * one all-day event per opportunity, spanning Production Start Date to
 * Estimated Delivery Date, titled with company + project + current stage,
 * color-coded by stage, owner in the description.
 *
 * Reuses Copper.gs (API client), Naming.gs (company normalisation),
 * Placement.gs (bucketForOpp_, stageNameOf_s), Handlers.gs (logSheet_),
 * Reconcile.gs (appendRows_) and Setup.gs (deleteTriggersFor_, clearCaches).
 *
 * Sync model: a full sweep of the Production pipeline (currently ~21 records)
 * every CAL_CONFIG.SYNC_EVERY_MINUTES. Events are found by a hidden tag
 * carrying the Copper opportunity id, so the sweep is idempotent and
 * self-healing: renames, stage changes, date changes and deletions all
 * converge on the next run. Manually created events (no tag) are never touched.
 *
 * ONE-TIME SETUP, run from the editor in this order:
 *   1. calSetupCreateCopperFields()   creates "Production Start Date" and
 *                                     "Estimated Delivery Date" Date fields in Copper
 *   2. calSetupCreateCalendar()       creates the "TotalShield Production Pipeline"
 *                                     calendar (id stored in Script Properties)
 *   3. calCheckSetup()                verifies fields, calendar, and shows sample titles
 *   4. calendarDryRun()               writes the planned events to the
 *                                     "Production Calendar" log tab; changes nothing
 *   5. syncProductionCalendar()       first real run
 *   6. installCalendarTrigger()       recurring sync
 * Then share the calendar with the team from the Google Calendar UI
 * (Settings > Share with specific people / your Workspace domain,
 * permission "See all event details"). Nobody edits the calendar by hand.
 */

var CAL_CONFIG = {
  CALENDAR_NAME: 'TotalShield Production Pipeline',
  SYNC_EVERY_MINUTES: 15,          // Apps Script allows 1, 5, 10, 15, 30

  // Copper custom field labels (matched by name, like the rest of the project)
  CF_PROD_START: 'Production Start Date',
  CF_PROD_DELIVERY: 'Estimated Delivery Date',
  CF_CO_OWNER: 'Co-Owner',

  // When Estimated Delivery Date is blank, fall back to the opportunity's
  // native close date so every project shows on the calendar from day one.
  USE_CLOSE_DATE_FALLBACK: true,

  // Events older than this many days past their end are left alone by the
  // cleanup pass (keeps the sweep window bounded).
  CLEANUP_LOOKBACK_DAYS: 200,
  CLEANUP_LOOKAHEAD_DAYS: 400,

  // Hidden tag key on every managed event; the value is the Copper opp id.
  TAG_KEY: 'copperOppId',

  LOG_SHEET: 'Production Calendar',
  LOG_HEADERS: ['opp_id', 'action', 'title', 'start', 'end', 'color', 'note'],

  // Stage -> event color. 13 stages, 11 Google colors, so phases share:
  // design/kickoff yellow, purchasing orange, fabrication blue, powder mauve,
  // packaging pale blue, shipped green, invoicing gray, installation cyan.
  STAGE_COLORS: {
    'Production Initiation':                                 CalendarApp.EventColor.YELLOW,
    'Waiting on Design Handoff Meeting/Design Finalization': CalendarApp.EventColor.YELLOW,
    'Purchasing Materials':                                  CalendarApp.EventColor.ORANGE,
    'Awaiting Materials or PO with Boyt':                    CalendarApp.EventColor.ORANGE,
    'Cutting Materials':                                     CalendarApp.EventColor.BLUE,
    'At Powder Coating':                                     CalendarApp.EventColor.MAUVE,
    'Producing Product':                                     CalendarApp.EventColor.BLUE,
    'Packaging Product':                                     CalendarApp.EventColor.PALE_BLUE,
    'Product Shipped':                                       CalendarApp.EventColor.GREEN,
    'Send 2nd Invoice':                                      CalendarApp.EventColor.GRAY,
    'Waiting on 2nd Payment':                                CalendarApp.EventColor.GRAY,
    'Active Installation':                                   CalendarApp.EventColor.CYAN,
    'Customer Installation Support':                         CalendarApp.EventColor.CYAN
  },
  DEFAULT_COLOR: CalendarApp.EventColor.GRAY
};

/* ---------------- Calendar handle ---------------- */

/** The production calendar, created on first use (id kept in Script Properties). */
function productionCalendar_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PRODUCTION_CAL_ID');
  if (id) {
    var cal = CalendarApp.getCalendarById(id);
    if (cal) return cal;
  }
  var created = CalendarApp.createCalendar(CAL_CONFIG.CALENDAR_NAME, {
    timeZone: CONFIG.TIMEZONE,
    summary: 'Auto-generated from the Copper Production pipeline. Do not edit events here; edit dates and stage in Copper.'
  });
  props.setProperty('PRODUCTION_CAL_ID', created.getId());
  calLogRow_(['-', 'create-calendar', CAL_CONFIG.CALENDAR_NAME, '', '', '', created.getId()]);
  return created;
}

/* ---------------- Date handling ---------------- */

/**
 * Parse anything Copper hands back for a date: unix seconds (Date custom
 * fields, date_created), "MM/DD/YYYY" (close_date), or "YYYY-MM-DD".
 * Returns a Date pinned to noon in CONFIG.TIMEZONE (safe for all-day math),
 * or null.
 */
function calParseDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  var d = null;
  if (typeof v === 'number' || /^\d{9,}$/.test(String(v))) {
    d = new Date(Number(v) * 1000);
  } else {
    var s = String(v).trim();
    var us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (us) return new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]), 12);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12);
    var t = new Date(s);
    if (!isNaN(t.getTime())) d = t;
  }
  if (!d) return null;
  // Re-anchor to the calendar date in the configured timezone, at noon.
  var p = Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-M-d').split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
}

function calDateStr_(d) { return d ? Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd') : ''; }

function calAddDays_(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12); }

function calDaysBetween_(a, b) { return Math.round((b - a) / 86400000); }

/* ---------------- Per-opportunity event spec ---------------- */

/**
 * Everything the event should look like for one Production opportunity.
 * Returns {skip: reason} when the record has no usable dates.
 */
function calEventSpec_(opp, companyCache) {
  var input = oppNamingInput_(opp, companyCache);
  var stage = stageNameOf_(opp) || '(no stage)';
  var start = calParseDate_(copperFieldValue_(opp, CAL_CONFIG.CF_PROD_START));
  var end = calParseDate_(copperFieldValue_(opp, CAL_CONFIG.CF_PROD_DELIVERY));
  var note = '';
  if (!end && CAL_CONFIG.USE_CLOSE_DATE_FALLBACK) {
    end = calParseDate_(opp.close_date);
    if (end) note = 'delivery from close date';
  }
  if (!start && !end) return { skip: 'no dates', oppId: opp.id };
  if (!start) { start = end; note = (note ? note + '; ' : '') + 'no start date'; }
  if (!end) { end = start; note = (note ? note + '; ' : '') + 'no delivery date'; }
  if (end < start) { end = start; note = (note ? note + '; ' : '') + 'delivery before start'; }

  // Any event whose delivery date has passed pins to today, flagged OVERDUE,
  // so past-due projects stay visible in the current view instead of hiding
  // in past months (also keeps them inside the managed-events scan window).
  var floor = calAddDays_(new Date(), 0);
  if (end < floor) {
    note = (note ? note + '; ' : '') + 'OVERDUE: was due ' + calDateStr_(end);
    start = calAddDays_(new Date(), 0);
    end = start;
  }

  var company = normalizeCompany_(input.companyName) || 'Unknown Company';
  var oppPart = trimOppName_(input.oppName, company);
  var title = company + (oppPart ? ' \u2013 ' + oppPart : '') + ' \u2014 ' + stage;
  if (title.length > 250) title = title.slice(0, 247) + '...';

  var owner = oppOwner_(opp);
  var coOwner = '';
  try { coOwner = String(copperFieldValue_(opp, CAL_CONFIG.CF_CO_OWNER) || ''); } catch (e) {}
  var days = calDaysBetween_(start, end) + 1;
  var lines = [
    'Stage: ' + stage,
    'Owner: ' + owner.name + (owner.email ? ' (' + owner.email + ')' : '')
  ];
  if (coOwner) lines.push('Co-Owner: ' + coOwner);
  lines.push('Estimated: ' + days + ' day' + (days > 1 ? 's' : '') +
    ' (' + calDateStr_(start) + ' \u2192 ' + calDateStr_(end) + ')');
  if (opp.monetary_value) lines.push('Value: $' + Number(opp.monetary_value).toLocaleString());
  lines.push('Copper: ' + copperOppUrl_(opp.id));
  var driveLink = '';
  try { driveLink = String(copperFieldValue_(opp, CONFIG.CF_DRIVE_LINK) || ''); } catch (e) {}
  if (driveLink) lines.push('Folder: ' + driveLink);
  if (note) lines.push('Note: ' + note);
  lines.push('');
  lines.push('Managed automatically from Copper. Edit dates and stage in Copper, not here; ' +
    'changes appear within ' + CAL_CONFIG.SYNC_EVERY_MINUTES + ' minutes.');

  return {
    oppId: opp.id,
    title: title,
    start: start,
    endExclusive: calAddDays_(end, 1),   // CalendarApp all-day end date is exclusive
    endInclusive: end,
    color: CAL_CONFIG.STAGE_COLORS[stage] || CAL_CONFIG.DEFAULT_COLOR,
    description: lines.join('\n'),
    note: note
  };
}

/* ---------------- Sweep ---------------- */

/** All active Production opportunities (Lost/Abandoned excluded via bucket logic). */
function calActiveProductionOpps_() {
  var pipeline = copperPipelines_().byName[CONFIG.PIPELINE_PRODUCTION];
  if (!pipeline) throw new Error('Pipeline not found: ' + CONFIG.PIPELINE_PRODUCTION);
  return copperSearchOpportunities_({ pipeline_ids: [pipeline.id] })
    .filter(function (o) { return bucketForOpp_(o) === 'PRODUCTION'; });
}

/** Index of managed events currently on the calendar: {oppId: [event, ...]}. */
function calManagedEvents_(calendar) {
  var from = calAddDays_(new Date(), -CAL_CONFIG.CLEANUP_LOOKBACK_DAYS);
  var to = calAddDays_(new Date(), CAL_CONFIG.CLEANUP_LOOKAHEAD_DAYS);
  var idx = {};
  calendar.getEvents(from, to).forEach(function (ev) {
    var tag = ev.getTag(CAL_CONFIG.TAG_KEY);
    if (!tag) return;                       // manual event: never touched
    (idx[tag] = idx[tag] || []).push(ev);
  });
  return idx;
}

/**
 * Bring the calendar into line with Copper. Options: {dryRun: true} lists
 * every planned create/update/delete in the log sheet and changes nothing.
 */
function syncProductionCalendar(options) {
  options = options || {};
  var dryRun = !!options.dryRun;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var calendar = productionCalendar_();
    var opps = calActiveProductionOpps_();
    var existing = calManagedEvents_(calendar);
    var companyCache = {};
    var rows = [];
    var active = {};

    opps.forEach(function (opp) {
      active[String(opp.id)] = true;
      try {
        var spec = calEventSpec_(opp, companyCache);
        if (spec.skip) {
          rows.push([new Date(), opp.id, 'skip', String(opp.name || ''), '', '', '', spec.skip]);
          return;
        }
        var list = existing[String(opp.id)] || [];
        var ev = list[0] || null;
        // Duplicates (should not happen, but self-heal): keep the first.
        for (var i = 1; i < list.length; i++) {
          if (!dryRun) list[i].deleteEvent();
          rows.push([new Date(), opp.id, 'delete-duplicate', list[i].getTitle(), '', '', '', '']);
        }
        if (!ev) {
          rows.push([new Date(), opp.id, 'create', spec.title, calDateStr_(spec.start), calDateStr_(spec.endInclusive), String(spec.color), spec.note]);
          if (dryRun) return;
          ev = calendar.createAllDayEvent(spec.title, spec.start, spec.endExclusive, { description: spec.description });
          ev.setTag(CAL_CONFIG.TAG_KEY, String(opp.id));
          ev.setColor(spec.color);
          return;
        }
        var changes = [];
        if (ev.getTitle() !== spec.title) changes.push('title');
        var curStart = ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime();
        var curEnd = ev.isAllDayEvent() ? ev.getAllDayEndDate() : ev.getEndTime();
        if (!ev.isAllDayEvent() ||
            calDateStr_(curStart) !== calDateStr_(spec.start) ||
            calDateStr_(curEnd) !== calDateStr_(spec.endExclusive)) changes.push('dates');
        if (String(ev.getColor()) !== String(spec.color)) changes.push('color');
        if (ev.getDescription() !== spec.description) changes.push('description');
        if (!changes.length) return;
        rows.push([new Date(), opp.id, 'update: ' + changes.join('+'), spec.title, calDateStr_(spec.start), calDateStr_(spec.endInclusive), String(spec.color), spec.note]);
        if (dryRun) return;
        if (changes.indexOf('title') !== -1) ev.setTitle(spec.title);
        if (changes.indexOf('dates') !== -1) ev.setAllDayDates(spec.start, spec.endExclusive);
        if (changes.indexOf('color') !== -1) ev.setColor(spec.color);
        if (changes.indexOf('description') !== -1) ev.setDescription(spec.description);
      } catch (e) {
        rows.push([new Date(), opp.id, 'error', String(opp.name || ''), '', '', '', String(e).slice(0, 300)]);
      }
    });

    // Cleanup: managed events whose opportunity left the Production pipeline
    // (shipped through to Closed Projects, marked Lost, or deleted in Copper).
    Object.keys(existing).forEach(function (oppId) {
      if (active[oppId]) return;
      existing[oppId].forEach(function (ev) {
        rows.push([new Date(), oppId, dryRun ? 'would-delete' : 'delete', ev.getTitle(), '', '', '', 'left Production pipeline']);
        if (!dryRun) ev.deleteEvent();
      });
    });

    if (rows.length) appendRows_(calLogSheet_(), rows);
    Logger.log((dryRun ? 'DRY RUN: ' : '') + 'calendar sync: ' + opps.length +
      ' production opportunities, ' + rows.length + ' actions logged.');
  } finally {
    lock.releaseLock();
  }
}

/** DRY RUN: log every planned action to the "Production Calendar" tab; change nothing. */
function calendarDryRun() { syncProductionCalendar({ dryRun: true }); }

/* ---------------- Logging ---------------- */

function calLogSheet_() { return logSheet_(CAL_CONFIG.LOG_SHEET, CAL_CONFIG.LOG_HEADERS); }

function calLogRow_(cells) {
  try { calLogSheet_().appendRow([new Date()].concat(cells)); }
  catch (e) { Logger.log('calendar log failed: ' + e); }
}

/* ---------------- Setup ---------------- */

/** One-time: create the two Date custom fields in Copper (no-op where they exist). */
function calSetupCreateCopperFields() {
  var defs = copperRequest_('GET', '/custom_field_definitions') || [];
  var byName = {};
  defs.forEach(function (d) { byName[d.name] = d; });
  [CAL_CONFIG.CF_PROD_START, CAL_CONFIG.CF_PROD_DELIVERY].forEach(function (label) {
    if (byName[label]) { Logger.log('Exists: "' + label + '" (id ' + byName[label].id + ')'); return; }
    var made = copperRequest_('POST', '/custom_field_definitions', {
      name: label, data_type: 'Date', available_on: ['opportunity']
    });
    Logger.log('Created: "' + label + '" (id ' + (made && made.id) + ')');
  });
  clearCaches();
}

/** One-time: create the calendar and print the id plus sharing instructions. */
function calSetupCreateCalendar() {
  var cal = productionCalendar_();
  Logger.log('Calendar ready: "' + cal.getName() + '" id ' + cal.getId());
  Logger.log('Now share it from the Google Calendar UI: Settings > "' + CAL_CONFIG.CALENDAR_NAME +
    '" > Share with specific people or your domain > permission "See all event details".');
}

/** Verify fields, pipeline, calendar; report date coverage and a sample title. */
function calCheckSetup() {
  var out = [];
  var defs = copperFieldDefs_().byName;
  [CAL_CONFIG.CF_PROD_START, CAL_CONFIG.CF_PROD_DELIVERY].forEach(function (l) {
    out.push((defs[l] ? 'OK   ' : 'MISSING ') + '"' + l + '"' + (defs[l] ? ' (' + defs[l].data_type + ', id ' + defs[l].id + ')' : ' - run calSetupCreateCopperFields()'));
  });
  var pl = copperPipelines_().byName[CONFIG.PIPELINE_PRODUCTION];
  out.push((pl ? 'OK   ' : 'MISSING ') + 'pipeline ' + CONFIG.PIPELINE_PRODUCTION);
  if (pl) {
    pl.stages.forEach(function (s) {
      out.push((CAL_CONFIG.STAGE_COLORS[s.name] ? 'color ' : 'NO COLOR (defaults gray) ') + ' <- ' + s.name);
    });
  }
  var calId = PropertiesService.getScriptProperties().getProperty('PRODUCTION_CAL_ID');
  out.push(calId ? 'OK   calendar id ' + calId : 'MISSING calendar - run calSetupCreateCalendar()');
  var opps = calActiveProductionOpps_();
  var withStart = 0, withDelivery = 0, withClose = 0;
  opps.forEach(function (o) {
    if (calParseDate_(copperFieldValue_(o, CAL_CONFIG.CF_PROD_START))) withStart++;
    if (calParseDate_(copperFieldValue_(o, CAL_CONFIG.CF_PROD_DELIVERY))) withDelivery++;
    if (calParseDate_(o.close_date)) withClose++;
  });
  out.push('Active production opportunities: ' + opps.length +
    ' | start date set: ' + withStart + ' | delivery date set: ' + withDelivery +
    ' | close date (fallback): ' + withClose);
  if (opps.length) {
    var spec = calEventSpec_(opps[0], {});
    out.push('Sample: ' + (spec.skip ? '(skipped: ' + spec.skip + ')' :
      spec.title + '  ' + calDateStr_(spec.start) + ' -> ' + calDateStr_(spec.endInclusive)));
  }
  Logger.log(out.join('\n'));
  return out;
}

/** Install the recurring sync (replaces any previous one). */
function installCalendarTrigger() {
  deleteTriggersFor_('syncProductionCalendar');
  ScriptApp.newTrigger('syncProductionCalendar').timeBased().everyMinutes(CAL_CONFIG.SYNC_EVERY_MINUTES).create();
  Logger.log('Calendar sync trigger installed (every ' + CAL_CONFIG.SYNC_EVERY_MINUTES + ' min)');
}

/** Remove the recurring sync. Events already on the calendar are left as-is. */
function removeCalendarTrigger() {
  deleteTriggersFor_('syncProductionCalendar');
  Logger.log('Calendar sync trigger removed');
}

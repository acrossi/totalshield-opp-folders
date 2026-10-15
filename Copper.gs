/**
 * Copper.gs - thin Copper Developer API client.
 * Docs: https://developer.copper.com/
 */

function copperHeaders_() {
  return {
    'X-PW-AccessToken': getSecret_('COPPER_API_KEY'),
    'X-PW-Application': 'developer_api',
    'X-PW-UserEmail': CONFIG.COPPER_USER_EMAIL,
    'Content-Type': 'application/json'
  };
}

function copperRequest_(method, path, payload) {
  var url = CONFIG.COPPER_BASE_URL + path;
  var opts = { method: method, headers: copperHeaders_(), muteHttpExceptions: true };
  if (payload !== undefined) opts.payload = JSON.stringify(payload);
  var attempt = 0, res, code;
  while (attempt < 4) {
    res = UrlFetchApp.fetch(url, opts);
    code = res.getResponseCode();
    if (code === 429 || code >= 500) { Utilities.sleep(1000 * Math.pow(2, attempt)); attempt++; continue; }
    break;
  }
  if (code < 200 || code >= 300) {
    throw new Error('Copper ' + method + ' ' + path + ' -> ' + code + ': ' + res.getContentText().slice(0, 500));
  }
  var text = res.getContentText();
  return text ? JSON.parse(text) : null;
}

function copperGetOpportunity_(id) { return copperRequest_('GET', '/opportunities/' + id); }
function copperGetCompany_(id) { return id ? copperRequest_('GET', '/companies/' + id) : null; }

function copperUpdateOpportunity_(id, body) { return copperRequest_('PUT', '/opportunities/' + id, body); }

/** Search opportunities, all pages. filter = body fields per Copper search API. */
function copperSearchOpportunities_(filter, maxPages) {
  var out = [], page = 1, size = 200;
  maxPages = maxPages || 100;
  while (page <= maxPages) {
    var body = Object.assign({ page_number: page, page_size: size, sort_by: 'date_created', sort_direction: 'desc' }, filter || {});
    var batch = copperRequest_('POST', '/opportunities/search', body) || [];
    out = out.concat(batch);
    if (batch.length < size) break;
    page++;
  }
  return out;
}

/** Custom field definitions, cached for 6 hours. Returns { byName: {label: def}, byId: {id: def} }. */
function copperFieldDefs_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('cfdefs');
  var defs = cached ? JSON.parse(cached) : copperRequest_('GET', '/custom_field_definitions');
  if (!cached) { try { cache.put('cfdefs', JSON.stringify(defs), 21600); } catch (e) {} }
  var byName = {}, byId = {};
  defs.forEach(function (d) { byName[d.name] = d; byId[d.id] = d; });
  return { byName: byName, byId: byId };
}

function copperFieldId_(label) {
  var d = copperFieldDefs_().byName[label];
  if (!d) throw new Error('Copper custom field not found: "' + label + '"');
  return d.id;
}

/** Read a custom field value off a record by label. Resolves dropdown option ids to names. */
function copperFieldValue_(record, label) {
  var defs = copperFieldDefs_();
  var def = defs.byName[label];
  if (!def || !record.custom_fields) return null;
  for (var i = 0; i < record.custom_fields.length; i++) {
    var cf = record.custom_fields[i];
    if (cf.custom_field_definition_id !== def.id) continue;
    var v = cf.value;
    if (def.data_type === 'Dropdown' && def.options && v != null) {
      for (var j = 0; j < def.options.length; j++) if (def.options[j].id === v) return def.options[j].name;
    }
    if (def.data_type === 'MultiSelect' && def.options && Array.isArray(v)) {
      return v.map(function (id) { var o = def.options.filter(function (x) { return x.id === id; })[0]; return o ? o.name : id; });
    }
    return v;
  }
  return null;
}

/** Build a custom_fields array for PUT from {label: value}. Skips labels that don't exist. */
function copperCustomFields_(map) {
  var defs = copperFieldDefs_().byName, arr = [];
  Object.keys(map).forEach(function (label) {
    if (defs[label]) arr.push({ custom_field_definition_id: defs[label].id, value: map[label] });
    else Logger.log('Skipping unknown custom field "' + label + '"');
  });
  return arr;
}

/** Pipelines with stages, cached 6 hours. Returns { byId: {id: pipeline}, byName: {name: pipeline} }. */
function copperPipelines_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('pipelines');
  var list = cached ? JSON.parse(cached) : copperRequest_('GET', '/pipelines');
  if (!cached) { try { cache.put('pipelines', JSON.stringify(list), 21600); } catch (e) {} }
  var byId = {}, byName = {};
  list.forEach(function (p) { byId[p.id] = p; byName[p.name] = p; });
  return { byId: byId, byName: byName };
}

/** Copper users, cached 6 hours. Returns {byId: {id: user}}. */
function copperUsers_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('users');
  var list = cached ? JSON.parse(cached) : copperRequest_('POST', '/users/search', { page_size: 200 });
  if (!cached) { try { cache.put('users', JSON.stringify(list), 21600); } catch (e) {} }
  var byId = {};
  (list || []).forEach(function (u) { byId[u.id] = u; });
  return { byId: byId };
}

/** {name, email} for an opportunity's assignee. Falls back to the "Historical Owner" custom
 * field (used for records whose owner left the company and cannot be a Copper assignee). */
function oppOwner_(opp) {
  var u = opp.assignee_id ? copperUsers_().byId[opp.assignee_id] : null;
  if (u) return { name: u.name, email: u.email };
  var hist = '';
  try { hist = copperFieldValue_(opp, CONFIG.CF_HIST_OWNER) || ''; } catch (e) {}
  return { name: hist ? String(hist) : 'Unassigned', email: '' };
}

function copperOppUrl_(id) { return CONFIG.COPPER_APP_URL + '#/browse/list/opportunities/default?fullProfile=opportunities-' + id; }

/* ---------------- Webhooks ---------------- */

function copperListWebhooks_() { return copperRequest_('GET', '/webhooks') || []; }

function copperCreateWebhook_(target, type, event) {
  return copperRequest_('POST', '/webhooks', {
    target: target, type: type, event: event,
    secret: { key: getSecret_('WEBHOOK_SECRET') }
  });
}

function copperDeleteWebhook_(id) { return copperRequest_('DELETE', '/webhooks/' + id); }

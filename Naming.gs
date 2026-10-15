/**
 * Naming.gs - pure functions that decide what a folder should be called.
 * Kept free of Drive/Copper calls so they can be unit tested.
 *
 * Target: YYYYMMDD_CODE_Company Name_Opportunity Name_ID-12345678
 */

/** Remove characters Drive dislikes or that break our separator scheme. */
function cleanSegment_(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[\/\\:*?"<>|]/g, ' ')     // filesystem-hostile
    .replace(/_/g, ' ')                 // underscore is our separator
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonical company name: trimmed, whitespace collapsed, legal suffix stripped, Title Case preserved. */
function normalizeCompany_(name) {
  var s = cleanSegment_(name);
  if (!s) return '';
  s = s.replace(/[,.\s]+$/, '');
  var suffixes = CONFIG.STRIP_COMPANY_SUFFIXES;
  var changed = true;
  while (changed) {
    changed = false;
    for (var i = 0; i < suffixes.length; i++) {
      var suf = suffixes[i];
      var re = new RegExp('[\\s,]+' + suf.replace(/\./g, '\\.') + '\\.?$', 'i');
      if (re.test(s)) { s = s.replace(re, '').replace(/[,.\s]+$/, ''); changed = true; }
    }
  }
  s = s.trim();
  if (CONFIG.TITLE_CASE_ALLCAPS && s.length > 3 && s === s.toUpperCase() && /[A-Z]/.test(s)) s = titleCaseAllCaps_(s);
  return s;
}

/** "BAUER COMPRESSORS" -> "Bauer Compressors", leaving configured acronyms and short tokens as they are. */
function titleCaseAllCaps_(s) {
  var acr = (CONFIG.ACRONYMS || []).map(function (a) { return a.toUpperCase(); });
  return s.split(' ').map(function (w) {
    if (!w) return w;
    if (acr.indexOf(w.toUpperCase()) !== -1) return w;
    if (w.length <= 2 || /\d/.test(w)) return w;
    return w.charAt(0) + w.slice(1).toLowerCase();
  }).join(' ');
}

/** Key used to compare company names regardless of case, punctuation and suffix. */
function companyKey_(name) {
  return normalizeCompany_(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Opportunity name with a leading "Company - " or "Company:" removed so we don't repeat it. */
function trimOppName_(oppName, companyName) {
  var s = cleanSegment_(oppName);
  var ck = companyKey_(companyName);
  if (!ck) return s;
  var parts = s.split(/\s+[-–:|]\s+/);
  if (parts.length > 1 && companyKey_(parts[0]) === ck) {
    return parts.slice(1).join(' - ').trim();
  }
  if (companyKey_(s) === ck) return '';
  return s;
}

/** Infer a product code from free text using CONFIG.PRODUCT_KEYWORDS; returns null when nothing matches. */
function inferProductFromText_(text) {
  if (!text) return null;
  var rules = CONFIG.PRODUCT_KEYWORDS || [];
  for (var i = 0; i < rules.length; i++) if (rules[i][0].test(text)) return rules[i][1];
  return null;
}

function productCode_(productTypeName) {
  if (!productTypeName) return CONFIG.DEFAULT_PRODUCT_CODE;
  return CONFIG.PRODUCT_CODES[productTypeName] || CONFIG.DEFAULT_PRODUCT_CODE;
}

/** yyyymmdd in CONFIG.TIMEZONE from a unix-seconds timestamp. Falls back to today. */
function dateCode_(unixSeconds) {
  var d = unixSeconds ? new Date(unixSeconds * 1000) : new Date();
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyyMMdd');
}

/**
 * Build the expected folder name.
 * @param {Object} p {id, dateCreated (unix s), companyName, oppName, productType}
 */
function buildFolderName_(p) {
  var sep = CONFIG.NAME_SEPARATOR;
  var company = normalizeCompany_(p.companyName) || 'UNKNOWN COMPANY';
  var code = p.productCodeOverride || productCode_(p.productType);
  var parts = [dateCode_(p.dateCreated), code, company];
  if (CONFIG.INCLUDE_OPP_NAME) {
    var opp = trimOppName_(p.oppName, company);
    if (opp) parts.push(opp);
  }
  var tail = sep + 'ID-' + p.id;
  var name = parts.join(sep);
  var max = CONFIG.MAX_NAME_LENGTH - tail.length;
  if (name.length > max) name = name.slice(0, max).trim();
  return name + tail;
}

/** Extract the Copper opportunity id from any folder name (new or legacy format). */
function parseIdFromName_(name) {
  var m = /ID-(\d{5,})\s*$/.exec(name || '');
  return m ? Number(m[1]) : null;
}

/** Company segment from an existing folder name (legacy "Company--OPP-..." or new "YYYYMMDD_CODE_Company_..."); '' if none. */
function companyFromFolderName_(name) {
  name = name || '';
  var legacy = /^(.+?)--OPP-/.exec(name);
  if (legacy && legacy[1].trim()) return legacy[1].trim();
  var modern = /^\d{8}_[A-Z0-9]{2,10}_([^_]+)_/.exec(name);
  if (modern && modern[1].trim() && modern[1].trim() !== 'UNKNOWN COMPANY') return modern[1].trim();
  return '';
}

/** True if the name already follows the new convention. */
function isNewFormat_(name) {
  return /^\d{8}_[A-Z0-9]{2,10}_.+_ID-\d+$/.test(name || '');
}

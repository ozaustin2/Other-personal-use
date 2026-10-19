/**
 * Listing.js: on-demand resale listing drafts from your own photos (never auto-posts).
 */

var DRAFT_ALLOWED_STATUSES = ['Picked Up', 'Repairing', 'Listed'];

/** Fetch a Drive image as a JPEG of reasonable size (Drive's thumbnail service also converts HEIC). */
function drivePhotoBlob_(file) {
  try {
    var r = UrlFetchApp.fetch('https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1568', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
    });
    if (r.getResponseCode() === 200 && /^image\//.test(r.getBlob().getContentType())) return r.getBlob().setName(file.getName());
  } catch (e) { /* fall back */ }
  var type = file.getMimeType();
  if (/^image\/(jpeg|png|webp|gif)$/.test(type) && file.getSize() < 4.5 * 1024 * 1024) return file.getBlob();
  return null;
}

/** Returns {ok, docUrl, ksl, facebook, photo_order, retakes} or {ok:false, error}. */
function draftListingFor_(dealId, notes) {
  var f = findDealRow_(dealId);
  if (!f) return { ok: false, error: 'Deal not found' };
  var deal = dealRowToObject_(f.values);
  if (DRAFT_ALLOWED_STATUSES.indexOf(deal.status) < 0) {
    return { ok: false, error: 'Set the status to Picked Up, Repairing or Listed first (it is "' + (deal.status || 'New') + '").' };
  }
  var folder = ensureDealFolder_(f.row);
  var photos = [];
  var files = folder.getFiles();
  while (files.hasNext() && photos.length < 8) {
    var file = files.next();
    if (!/^image\//.test(file.getMimeType())) continue;
    var blob = drivePhotoBlob_(file);
    if (blob) photos.push({ name: file.getName(), blob: blob });
  }
  if (!photos.length) {
    return { ok: false, error: 'No photos yet. Upload your photos to the item folder first: ' + folder.getUrl(), folder: folder.getUrl() };
  }
  var d = aiDraftListing_(deal, photos, notes);

  var doc = DocumentApp.create('Listing draft – ' + truncate_(deal.title, 60));
  var bodyEl = doc.getBody();
  bodyEl.appendParagraph('Listing drafts: ' + deal.title).setHeading(DocumentApp.ParagraphHeading.TITLE);
  bodyEl.appendParagraph('Generated ' + fmtTime_() + '. Review before posting; nothing is posted automatically.').setItalic(true);
  [['KSL Classifieds', d.ksl], ['Facebook Marketplace', d.facebook]].forEach(function (pair) {
    var x = pair[1];
    bodyEl.appendParagraph(pair[0]).setHeading(DocumentApp.ParagraphHeading.HEADING1);
    bodyEl.appendParagraph('Title: ' + x.title).setItalic(false);
    bodyEl.appendParagraph('Price: $' + x.price + '  ·  Category: ' + x.category);
    bodyEl.appendParagraph('Pricing: ' + x.pricing_guidance);
    bodyEl.appendParagraph(x.description);
  });
  bodyEl.appendParagraph('Photo order').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  d.photo_order.forEach(function (n, i) { bodyEl.appendListItem((i + 1) + '. ' + n); });
  if (d.retakes.length) {
    bodyEl.appendParagraph('Retakes / extra shots').setHeading(DocumentApp.ParagraphHeading.HEADING1);
    d.retakes.forEach(function (r) { bodyEl.appendListItem(r); });
  }
  doc.saveAndClose();
  var docFile = DriveApp.getFileById(doc.getId());
  docFile.moveTo(folder);
  setDealField_(f.row, 'draft_url', doc.getUrl());
  logEvent_('info', 'draft', 'Drafted listing for ' + deal.title);
  return { ok: true, docUrl: doc.getUrl(), ksl: d.ksl, facebook: d.facebook, photo_order: d.photo_order, retakes: d.retakes, folder: folder.getUrl() };
}

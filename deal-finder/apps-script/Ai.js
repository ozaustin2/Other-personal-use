/**
 * Ai.js: Claude API calls (raw HTTP; Apps Script has no Anthropic SDK).
 *
 * Cheap model (MODEL_FILTER, default claude-haiku-5-5): batch filter + quick value guess.
 * Valuation model (MODEL_VALUE, default claude-haiku-5-5): valuation/scoring and share extraction.
 * Draft model (MODEL_DRAFT, default claude-sonnet-5-5): resale listing drafts, only when you ask.
 * Every call logs its cost to the Logs tab under job "claude:<task>".
 */

var CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

/** USD per million tokens [input, output]. Unknown models fall back to Sonnet pricing for budgeting. */
var CLAUDE_PRICES = {
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2.00, 10.00],
  'claude-opus-5-5': [4.00, 20.00]
};

var OWNER_PROFILE =
  'The buyer is an A&P aircraft mechanic in North Salt Lake, Utah (ZIP 84054). Strong with electronics, ' +
  'electrical components and appliances; good with mechanical repair (small engines, motors). ' +
  'Has a truck. Goal: pick up free or underpriced items, repair if needed, and resell locally on KSL Classifieds ' +
  'and Facebook Marketplace for profit.';

/**
 * Low-level call. `content` is a user content array (text/image blocks). `schema` (JSON Schema) forces JSON output.
 * Returns the parsed JSON object.
 */
function claudeJson_(task, model, system, content, schema, opts) {
  opts = opts || {};
  var body = {
    model: model,
    max_tokens: opts.maxTokens || 8000,
    system: system,
    messages: [{ role: 'user', content: content }],
    output_config: {
      effort: opts.effort || 'medium',
      format: { type: 'json_schema', schema: schema }
    }
  };
  var headers = {
    'x-api-key': requireProp_(PROP.ANTHROPIC_API_KEY),
    'anthropic-version': '2023-06-01'
  };
  // Server-side refusal fallback (retries a refused request on a suitable model). Claude API only.
  if (/^claude-(sonnet-5-5|opus-5-5|opus-5|fable)/.test(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  var resp = http_(CLAUDE_URL, {
    method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(body)
  }, 3);
  if (resp.code !== 200 || !resp.json) {
    throw new Error('Claude ' + task + ' HTTP ' + resp.code + ': ' + truncate_(resp.text, 300));
  }
  var msg = resp.json;
  logClaudeCost_(task, msg.model || model, msg.usage);
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined the ' + task + ' request');
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude ' + task + ' hit max_tokens');
  var text = (msg.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  return JSON.parse(text);
}

function logClaudeCost_(task, model, usage) {
  if (!usage) return;
  var key = Object.keys(CLAUDE_PRICES).filter(function (k) { return model.indexOf(k) === 0; })[0] || 'claude-sonnet-5-5';
  var p = CLAUDE_PRICES[key];
  var input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  var cost = (input * p[0] + (usage.output_tokens || 0) * p[1]) / 1e6;
  logEvent_('cost', 'claude:' + task, model + ' in=' + usage.input_tokens + ' out=' + usage.output_tokens, Math.round(cost * 100000) / 100000);
}

/** Fetch an image URL and return a base64 image block, or null if it can't be fetched. */
function imageBlockFromUrl_(url) {
  if (!url) return null;
  try {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (resp.getResponseCode() !== 200) return null;
    var blob = resp.getBlob();
    var type = (blob.getContentType() || '').split(';')[0];
    if (!/^image\/(jpeg|png|gif|webp)$/.test(type)) type = 'image/jpeg';
    var bytes = blob.getBytes();
    if (bytes.length > 4.5 * 1024 * 1024) return null;
    return { type: 'image', source: { type: 'base64', media_type: type, data: Utilities.base64Encode(bytes) } };
  } catch (e) {
    return null;
  }
}

function imageBlockFromBlob_(blob) {
  var bytes = blob.getBytes();
  if (bytes.length > 4.5 * 1024 * 1024) return null;
  var type = (blob.getContentType() || 'image/jpeg').split(';')[0];
  return { type: 'image', source: { type: 'base64', media_type: type, data: Utilities.base64Encode(bytes) } };
}

// ---------------------------------------------------------------------------
// 1. Batch filter (cheap model)

var FILTER_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          keep: { type: 'boolean' },
          reason: { type: 'string' },
          category: { type: 'string' },
          quick_resale_guess: { type: 'number' },
          needs_detail: { type: 'boolean' }
        },
        required: ['i', 'keep', 'reason', 'category', 'quick_resale_guess', 'needs_detail'],
        additionalProperties: false
      }
    }
  },
  required: ['results'],
  additionalProperties: false
};

var FILTER_SYSTEM = OWNER_PROFILE + '\n\n' +
  'You triage marketplace listings. For each listing decide keep=true/false.\n' +
  'DROP: couches, sofas, sectionals, recliners, mattresses, bed frames, dressers, tables, chairs, cabinets and other furniture; ' +
  'clothing; firewood; dirt/rock/mulch; pallets; scrap wood; baby gear; pets/animals; vague "curb alert" posts with no identifiable item; ' +
  'anything illegal or restricted (firearms, ammunition, etc.); vehicles/real estate/services/jobs/wanted ads.\n' +
  'KEEP: electronics, AV, computers, gaming, appliances (including freeze dryers), small engines, outdoor power equipment, ' +
  'generators, power tools, compressors, welders, e-bikes, scooters, motors, test equipment, HVAC components, unusual or specialty items. ' +
  'When unsure, keep.\n' +
  'category: one of appliances, freeze dryers, small engines, outdoor power, power tools, e-mobility, electronics, av, computers, gaming, ' +
  'test equipment, hvac, other, or the drop reason category.\n' +
  'quick_resale_guess: rough local resale value in USD if repaired/working (0 if dropped).\n' +
  'needs_detail: true if the title alone is too vague to value and the full description would help.\n' +
  'reason: a few words.';

/** items: normalized items. Returns array aligned with items: {keep, reason, category, quick_resale_guess, needs_detail}. */
function aiFilterBatch_(items) {
  var lines = items.map(function (it, i) {
    return JSON.stringify({
      i: i, title: it.title, price: it.price, city: it.city, source: it.source,
      category_hint: it.category_hint || '', search: it.matched_search || '',
      description: truncate_(it.description || '', 400)
    });
  }).join('\n');
  var out = claudeJson_('filter', settingStr_('MODEL_FILTER'), FILTER_SYSTEM,
    [{ type: 'text', text: 'Listings (one JSON per line):\n' + lines }],
    FILTER_SCHEMA, { effort: 'low', maxTokens: 6000 });
  var byI = {};
  (out.results || []).forEach(function (r) { byI[r.i] = r; });
  return items.map(function (it, i) {
    return byI[i] || { keep: true, reason: 'no AI verdict (kept)', category: 'other', quick_resale_guess: 0, needs_detail: false };
  });
}

// ---------------------------------------------------------------------------
// 2. Valuation (strong model)

var VALUE_SCHEMA = {
  type: 'object',
  properties: {
    item_type: { type: 'string' },
    category: { type: 'string' },
    brand_model_guess: { type: 'string' },
    condition_guess: { type: 'string' },
    likely_fault: { type: 'string' },
    est_resale_low: { type: 'number' },
    est_resale_high: { type: 'number' },
    est_parts_cost: { type: 'number' },
    est_repair_hours: { type: 'number' },
    repair_difficulty: { type: 'integer', description: '1 (trivial) – 5 (beyond this buyer)' },
    pickup_effort: { type: 'integer', description: '1 (fits in a car) – 5 (trailer/stairs/crew)' },
    demand: { type: 'integer', description: 'Local sell-through/demand 1 (slow) – 5 (sells same day)' },
    opportunity_score: { type: 'integer', description: '1–10 before distance-tier caps' },
    reasoning: { type: 'string', description: '2–3 sentences' }
  },
  required: ['item_type', 'category', 'brand_model_guess', 'condition_guess', 'likely_fault', 'est_resale_low', 'est_resale_high',
    'est_parts_cost', 'est_repair_hours', 'repair_difficulty', 'pickup_effort', 'demand', 'opportunity_score', 'reasoning'],
  additionalProperties: false
};

function valueSystemPrompt_() {
  var weights = getConfig_().weights;
  var wText = Object.keys(weights).map(function (k) { return k + ' ' + weights[k]; }).join(', ');
  return OWNER_PROFILE + '\n\n' +
    'Value one listing as a flip opportunity. Estimate realistic LOCAL resale (KSL/Facebook, Salt Lake area) for the item ' +
    'once working/cleaned, not retail or eBay asking. eBay comps (if given) are active listings already discounted to approximate a local price; ' +
    'adjust for condition, completeness and local demand.\n' +
    'repair_difficulty is calibrated to THIS buyer: electrical/electronic/appliance faults are easier for him than for an average person.\n' +
    'pickup_effort: size, weight, truck/trailer, stairs.\n' +
    'opportunity_score 1–10 combines profit, profit per hour, demand/sell-through, difficulty fit and pickup effort. ' +
    '8+ means drop-everything good; 5–7 worth a look; 1–4 skip. Free working items with real resale value score high. ' +
    'Category priorities (multipliers applied later, for context): ' + wText + '.\n' +
    'If the listing is too vague to value, give a conservative estimate and say so in reasoning.' +
    calibrationNotes_();
}

/** item: normalized; comps: {median, count, examples} or null. Returns VALUE_SCHEMA object. */
function aiValuate_(item, comps) {
  var info = {
    title: item.title, asking_price: item.price, city: item.city, distance_miles: item.distance_miles,
    source: item.source, posted: item.posted_at || '', condition_listed: item.condition || '',
    matched_search: item.matched_search || '', description: truncate_(item.description || '', 3000),
    ebay_comps: comps || 'none found'
  };
  var content = [];
  var imgs = (item.image_urls && item.image_urls.length ? item.image_urls : [item.image_url]).filter(Boolean).slice(0, 3);
  imgs.forEach(function (u) { var b = imageBlockFromUrl_(u); if (b) content.push(b); });
  content.push({ type: 'text', text: 'Listing:\n' + JSON.stringify(info, null, 1) });
  return claudeJson_('value', settingStr_('MODEL_VALUE'), valueSystemPrompt_(), content, VALUE_SCHEMA,
    { effort: settingStr_('VALUE_EFFORT') || 'medium', maxTokens: 12000 });
}

// ---------------------------------------------------------------------------
// 3. Manual share extraction (vision)

var SHARE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    price: { type: 'number', description: '0 for free; -1 if unknown' },
    city: { type: 'string' },
    state: { type: 'string' },
    description: { type: 'string' },
    source: { type: 'string', description: 'Facebook, KSL, Craigslist, OfferUp, Facebook group, or Other' },
    posted: { type: 'string' }
  },
  required: ['title', 'price', 'city', 'state', 'description', 'source', 'posted'],
  additionalProperties: false
};

function aiExtractShare_(text, url, imageBlob) {
  var content = [];
  if (imageBlob) { var b = imageBlockFromBlob_(imageBlob); if (b) content.push(b); }
  content.push({ type: 'text', text: 'Shared listing.\nURL: ' + (url || '(none)') + '\nShared text: ' + truncate_(text || '', 4000) +
    '\nExtract the listing details from the screenshot and text. Use "" for unknown strings.' });
  return claudeJson_('share', settingStr_('MODEL_VALUE'), 'You extract marketplace listing details from screenshots and shared text.',
    content, SHARE_SCHEMA, { effort: 'low', maxTokens: 4000 });
}

// ---------------------------------------------------------------------------
// 4. Resale listing drafts (vision, on demand)

var DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    ksl: {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' }, price: { type: 'number' }, category: { type: 'string' }, pricing_guidance: { type: 'string' } },
      required: ['title', 'description', 'price', 'category', 'pricing_guidance'], additionalProperties: false
    },
    facebook: {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' }, price: { type: 'number' }, category: { type: 'string' }, pricing_guidance: { type: 'string' } },
      required: ['title', 'description', 'price', 'category', 'pricing_guidance'], additionalProperties: false
    },
    photo_order: { type: 'array', items: { type: 'string' }, description: 'Photo file names, best first' },
    retakes: { type: 'array', items: { type: 'string' } }
  },
  required: ['ksl', 'facebook', 'photo_order', 'retakes'],
  additionalProperties: false
};

/** photos: [{name, blob}] */
function aiDraftListing_(deal, photos, notes) {
  var content = [];
  photos.forEach(function (p) {
    var b = imageBlockFromBlob_(p.blob);
    if (b) { content.push({ type: 'text', text: 'Photo: ' + p.name }); content.push(b); }
  });
  content.push({
    type: 'text', text: 'Item data:\n' + JSON.stringify({
      title: deal.title, item_type: deal.item_type, brand_model: deal.brand_model_guess, condition_when_bought: deal.condition_guess,
      fault_when_bought: deal.likely_fault, est_resale_low: deal.est_resale_low, est_resale_high: deal.est_resale_high, status: deal.status,
      owner_notes: notes || ''
    }, null, 1) +
      '\n\nWrite a KSL Classifieds listing and a Facebook Marketplace listing for reselling this item locally (Salt Lake area). ' +
      'Honest, specific, scannable: what it is, model, condition, what was repaired/tested, what is included, pickup in North Salt Lake. ' +
      'No emojis spam, no ALL CAPS. KSL category should be a real KSL category/subcategory; Facebook category a real Marketplace category. ' +
      'pricing_guidance: list price, firm vs OBO, and the lowest price to accept. Order photos best-first and list any retakes needed (angles, model plate, working demo, lighting).'
  });
  return claudeJson_('draft', settingStr_('MODEL_DRAFT') || settingStr_('MODEL_VALUE'), OWNER_PROFILE + '\nYou write resale listings that sell fast at a fair price.',
    content, DRAFT_SCHEMA, { effort: 'medium', maxTokens: 12000 });
}

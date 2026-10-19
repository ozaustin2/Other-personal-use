/**
 * Filter.js: free rule-based pre-filter (runs before any AI call) plus the keyword pre-filter
 * that decides whether a KSL listing is worth a detail-page fetch.
 */

/** Obvious drops by title. Conservative: anything ambiguous goes on to the AI filter. */
var DROP_RULES = [
  ['furniture', /\b(couch|sofa|sectional|loveseat|love seat|recliner|futon|ottoman|mattress|box spring|bed ?frame|headboard|bunk ?bed|crib|dresser|nightstand|night stand|armoire|wardrobe|bookshel(f|ves)|bookcase|entertainment center|tv stand|coffee table|end table|dining (table|set|room)|kitchen table|desk chair|office chair|chairs?|stools?|bench|cabinets?|hutch|credenza)\b/i],
  ['clothing', /\b(clothes|clothing|shirts?|pants|jeans|dress(es)?|shoes|boots|jackets?|coats?|hoodie|costume)\b/i],
  ['firewood / landscaping material', /\b(firewood|fire wood|dirt|fill dirt|top ?soil|rocks?|gravel|mulch|sod|bark chips|landscape rock|pavers?)\b/i],
  ['pallets / scrap wood', /\b(pallets?|scrap wood|lumber scraps?|wood scraps?|plywood)\b/i],
  ['baby gear', /\b(stroller|car seat|high ?chair|pack ?n ?play|playpen|baby (gear|clothes|items|swing|bouncer)|diapers?)\b/i],
  ['pets / animals', /\b(puppy|puppies|kittens?|chickens?|hens|rooster|rabbits?|bunny|bunnies|horses?|goats?|hamsters?|guinea pigs?|ducklings?|rehome|rehoming|adoption)\b/i],
  ['restricted', /\b(guns?|rifle|pistol|handgun|shotgun|ammo|ammunition|firearm|ar-?15|suppressor|silencer)\b/i],
  ['vague curb alert', /^\s*(curb ?alert|free stuff|misc(ellaneous)?( items| stuff)?|free!*|stuff|junk)\s*!*\s*$/i]
];

/** Words that make a title worth keeping even if a drop rule matches (e.g. "massage chair", "chair lift motor"). */
var RESCUE_RX = /\b(massage|electric|power|motor|lift|recliner motor|lift chair|gaming chair|generator|compressor|welder|appliance|freezer|fridge|refrigerator|washer|dryer|tv|monitor|computer|laptop|speaker|amp|amplifier|receiver|engine|mower|snow ?blower|tool|drill|saw|e-?bike|scooter|battery|solar|inverter|hvac|furnace|air condition)/i;

/** Returns a drop reason string or '' to keep. */
function ruleFilter_(item) {
  var title = String(item.title || '');
  if (!title.trim()) return 'no title';
  for (var i = 0; i < DROP_RULES.length; i++) {
    if (DROP_RULES[i][1].test(title)) {
      if (DROP_RULES[i][0] !== 'restricted' && RESCUE_RX.test(title)) return '';
      return DROP_RULES[i][0];
    }
  }
  return '';
}

/** Target words that justify spending a KSL detail-page fetch. */
var DETAIL_WORTHY_RX = /\b(freeze dryer|harvest right|generator|snow ?blower|e-?bike|electric bike|scooter|welder|compressor|mower|zero turn|riding|tractor|trimmer|chainsaw|pressure washer|tiller|engine|motor|honda|predator|champion|dewalt|milwaukee|makita|ryobi|ego|craftsman|snap-?on|lincoln|miller|hobart|fridge|refrigerator|freezer|washer|dryer|dishwasher|range|oven|microwave|ice maker|kegerator|wine cooler|tv|television|monitor|projector|receiver|amplifier|amp|speaker|subwoofer|turntable|computer|laptop|pc|gaming|xbox|playstation|ps[345]|nintendo|switch|drone|printer|3d printer|ups|battery|inverter|solar|hvac|furnace|air condition|a\/c|heat pump|oscilloscope|multimeter|test equipment|commercial|industrial|not working|needs repair|for parts|broken)\b/i;

function detailWorthy_(item) {
  return DETAIL_WORTHY_RX.test(String(item.title || '') + ' ' + String(item.matched_search || ''));
}

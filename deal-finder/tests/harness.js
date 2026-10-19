// Loads every Apps Script .js file into one Node vm context (shared global scope, like Apps Script)
// with minimal stubs for Google services. Only pure logic is exercised by the tests.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAppsScript(overrides = {}) {
  const dir = path.join(__dirname, '..', 'apps-script');
  const props = {};
  const ctx = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = String(v); } }),
      getDocumentProperties: () => null,
    },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => null },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .formatToParts(d).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
        return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day).replace('HH', parts.hour).replace('mm', parts.minute).replace(/\bd\b/, String(Number(parts.day)));
      },
      sleep: () => {},
    },
    ...overrides,
  };
  vm.createContext(ctx);
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  ctx.__props = props;
  return ctx;
}

module.exports = { loadAppsScript };

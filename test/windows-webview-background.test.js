const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "../TokenTrackerWin", file), "utf8");

test("tray summary updates never wake the dashboard renderer to read currency", () => {
  const source = read("TrayApplicationContext.cs");
  const summary = source.slice(source.indexOf("private Task RefreshSummaryOnceAsync()"), source.indexOf("private void PersistCurrencyFromDashboard()"));
  assert.match(summary, /var \(symbol, rate\) = _summaryCurrency;/);
  assert.doesNotMatch(summary, /ReadCurrencyAsync|ExecuteScriptAsync|ReadPersisted/);
  const persist = source.slice(source.indexOf("private async Task PersistCurrencyFromDashboardAsync()"), source.indexOf("private void PostToUi("));
  assert.match(persist, /revision != _currencyReadRevision/);
  assert.match(persist, /currency is null\) return;/);
  assert.match(persist, /_summaryCurrency = \(symbol, rate\);[\s\S]*RefreshSummary\(\);/);
});

test("failed currency reads preserve the last known currency instead of persisting USD", () => {
  const source = read("DashboardWindow.cs");
  const currency = source.slice(source.indexOf("public async Task<(string Symbol, decimal Rate)?> ReadCurrencyAsync()"), source.indexOf("public async Task<string> ReadLocalePreferenceAsync()"));
  assert.match(currency, /if \(!_coreReady\) return null;/);
  assert.match(currency, /catch \{ return null; \}/);
});

test("hidden and minimized dashboards suspend with OAuth and restore race protection", () => {
  const source = read("DashboardWindow.cs");
  assert.match(source, /IsVisibleChanged[^\n]*UpdateWebViewVisibilityAsync/);
  const visibility = source.slice(source.indexOf("private async Task UpdateWebViewVisibilityAsync()"), source.indexOf("private void CloseOrHideForOAuth()"));
  assert.match(visibility, /IsVisible && WindowState != WindowState.Minimized/);
  assert.match(visibility, /Visibility.Collapsed/);
  assert.match(visibility, /if \(visible \|\| _oauthInFlight\) core.Resume\(\);/);
  assert.match(visibility, /await core.TrySuspendAsync\(\)/);
  assert.match(visibility, /core == _webView.CoreWebView2[\s\S]*\|\| _oauthInFlight\)\)[\s\S]*core.Resume\(\);/);
  const oauth = source.slice(source.indexOf("private void BeginNativeOAuth()"), source.indexOf("private async Task WaitForNativeOAuthTimeoutAsync("));
  assert.match(oauth, /_oauthInFlight = true;[\s\S]*UpdateWebViewVisibilityAsync/);
});

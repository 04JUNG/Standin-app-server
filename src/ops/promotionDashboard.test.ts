import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { DASHBOARD_HTML } from "./dashboard.js";

test("promotion keeps marketing controls and every develop navigation destination", () => {
  for (const name of ["overview","jobs","installs","gallery","metrics","bodies","ops","replay","marketing"]) {
    assert.ok(DASHBOARD_HTML.includes(`data-tab="${name}"`), `${name} navigation`);
    assert.ok(DASHBOARD_HTML.includes(`id="tab-${name}"`), `${name} content`);
  }
  const ids = [...DASHBOARD_HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  for (const id of ["marketingScope","marketingRefresh","marketingMsg","marketingOut"])
    assert.equal(ids.filter(v=>v===id).length,1, `${id} exists exactly once before listeners attach`);
  const scripts=[...DASHBOARD_HTML.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  for (const [,code] of scripts) new vm.Script(code);
});

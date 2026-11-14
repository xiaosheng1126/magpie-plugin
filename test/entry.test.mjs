import assert from "node:assert/strict";
import test from "node:test";
import { DlPlugin } from "../index.mjs";
import * as v1 from "../opencode.mjs";
import { pluginsOf } from "../opencode2.mjs";

test("the package entry exports DL from one repository", () => {
  assert.equal(typeof DlPlugin, "function");
});

test("OpenCode/Magpie face exposes the DL plugin", () => {
  const plugins = pluginsOf(v1);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, DlPlugin.name);
});

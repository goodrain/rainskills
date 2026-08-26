"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createRuntimeContextResolver,
} = require("../rainbond-platform-installer/scripts/runtime-context-resolver.js");

function operationFixture() {
  let operation = {
    operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    context_revision: 0,
    context: {
      enterprise_id: null,
      team_id: null,
      team_name: null,
      region_name: null,
    },
    pending_selection: null,
  };
  return {
    read: () => JSON.parse(JSON.stringify(operation)),
    updateContext(_id, { expectedRevision, values, pendingSelection }) {
      assert.equal(expectedRevision, operation.context_revision);
      operation = {
        ...operation,
        context_revision: operation.context_revision + 1,
        context: { ...operation.context, ...values },
        pending_selection: pendingSelection === undefined
          ? operation.pending_selection
          : pendingSelection,
      };
      return this.read();
    },
  };
}

test("resolver obtains enterprise and auto-selects the only accessible workspace-region", async () => {
  const operationStore = operationFixture();
  const calls = [];
  const resolver = createRuntimeContextResolver({
    operationStore,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    queryTool: async (name, input) => {
      calls.push([name, input]);
      if (name === "rainbond_get_current_user") return { enterprise_id: "enterprise-1" };
      return {
        items: [{
          tenant_id: "team-1",
          tenant_name: "default",
          roles: ["owner"],
          region_list: [{ region_name: "rainbond", region_alias: "默认集群" }],
        }],
        total: 1,
        page: 1,
        page_size: 20,
      };
    },
  });

  const result = await resolver.resolve({
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    required: ["enterprise", "workspace"],
  });

  assert.equal(result.state, "resolved");
  assert.equal(result.context.enterprise_id, "enterprise-1");
  assert.equal(result.context.team_id, "team-1");
  assert.equal(result.context.region_name, "rainbond");
  assert.deepEqual(calls.map(([name]) => name), [
    "rainbond_get_current_user",
    "rainbond_query_teams",
  ]);
});

test("resolver returns one combined selection for multiple workspace-region choices and persists it", async () => {
  const operationStore = operationFixture();
  let teamQueries = 0;
  const resolver = createRuntimeContextResolver({
    operationStore,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    queryTool: async (name) => {
      if (name === "rainbond_get_current_user") return { enterprise_id: "enterprise-1" };
      teamQueries += 1;
      return {
        items: [
          { tenant_id: "team-a", tenant_name: "开发", roles: ["developer"], region_list: [{ region_name: "r1", region_alias: "北京" }] },
          { tenant_id: "team-b", tenant_name: "生产", roles: ["owner"], region_list: [{ region_name: "r2", region_alias: "上海" }] },
        ],
        total: 2,
        page: 1,
        page_size: 20,
      };
    },
  });

  const pending = await resolver.resolve({
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    required: ["enterprise", "workspace"],
  });
  assert.equal(pending.state, "needs-selection");
  assert.equal(pending.dimension, "workspace-region");
  assert.deepEqual(pending.options.map((entry) => entry.label), [
    "开发 / 北京",
    "生产 / 上海",
  ]);

  const selected = await resolver.select({
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    selectionId: pending.selection_id,
    optionId: pending.options[1].id,
  });
  assert.equal(selected.state, "resolved");
  assert.equal(selected.context.team_id, "team-b");
  assert.equal(selected.context.region_name, "r2");

  const reused = await resolver.resolve({
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    required: ["enterprise", "workspace"],
  });
  assert.equal(reused.state, "resolved");
  assert.equal(teamQueries, 1);
});

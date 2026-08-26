"use strict";

const { createHash, randomUUID: nodeRandomUUID } = require("node:crypto");

const MAX_OPTIONS = 256;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundedString(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ? value
    : null;
}

function optionUuid(teamId, regionName) {
  const digest = createHash("sha256").update(`${teamId}\0${regionName}`, "utf8").digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function normalizeWorkspaceOptions(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
    throw new Error("Rainbond 工作空间查询结果无效");
  }
  const options = [];
  for (const item of payload.items) {
    if (!item || typeof item !== "object") continue;
    const teamId = boundedString(item.team_id || item.tenant_id);
    const teamName = boundedString(item.team_name || item.tenant_name);
    const teamAlias = boundedString(item.team_alias || item.tenant_alias);
    if (!teamId || !teamName || !Array.isArray(item.region_list)) continue;
    for (const region of item.region_list) {
      const regionName = boundedString(region?.region_name);
      if (!regionName) continue;
      const regionLabel = boundedString(region.region_alias) || regionName;
      const workspaceLabel = teamAlias && teamAlias !== teamName
        ? `${teamAlias}（${teamName}）`
        : teamName;
      options.push({
        id: optionUuid(teamId, regionName),
        label: `${workspaceLabel} / ${regionLabel}`,
        team_id: teamId,
        team_name: teamName,
        team_alias: teamAlias,
        region_name: regionName,
      });
      if (options.length > MAX_OPTIONS) throw new Error("candidate-set-too-large");
    }
  }
  return options.sort((left, right) => (
    left.team_id.localeCompare(right.team_id) || left.region_name.localeCompare(right.region_name)
  ));
}

function createRuntimeContextResolver({
  operationStore,
  queryTool,
  randomUUID = nodeRandomUUID,
} = {}) {
  if (!operationStore || typeof operationStore.read !== "function"
    || typeof operationStore.updateContext !== "function") {
    throw new Error("runtime context resolver 缺少 operation store");
  }
  if (typeof queryTool !== "function") throw new Error("runtime context resolver 缺少只读查询 transport");

  async function resolve({ operationId, required = [] } = {}) {
    if (!Array.isArray(required) || required.some((item) => !["enterprise", "workspace"].includes(item))) {
      throw new Error("runtime context required dimensions 无效");
    }
    let operation = operationStore.read(operationId);
    if (!operation) throw new Error("runtime operation 不存在");
    if (operation.pending_selection) {
      return {
        schema: "rainskills.context-result.v1",
        state: "needs-selection",
        selection_id: operation.pending_selection.selection_id,
        dimension: operation.pending_selection.dimension,
        options: operation.pending_selection.options.map(({ id, label }) => ({ id, label })),
      };
    }

    if (required.includes("enterprise") && !operation.context.enterprise_id) {
      const identity = await queryTool("rainbond_get_current_user", {});
      const enterpriseId = boundedString(identity?.enterprise_id);
      if (!enterpriseId) {
        return {
          schema: "rainskills.context-result.v1",
          state: "blocked",
          reason: "no-current-enterprise",
          message_id: "context.no-current-enterprise",
        };
      }
      operation = operationStore.updateContext(operationId, {
        expectedRevision: operation.context_revision,
        values: { enterprise_id: enterpriseId },
      });
    }

    const workspaceResolved = operation.context.team_id && operation.context.region_name;
    if (required.includes("workspace") && !workspaceResolved) {
      const teams = await queryTool("rainbond_query_teams", {
        enterprise_id: operation.context.enterprise_id,
      });
      const options = normalizeWorkspaceOptions(teams);
      if (options.length === 0) {
        return {
          schema: "rainskills.context-result.v1",
          state: "blocked",
          reason: "no-accessible-workspace",
          message_id: "context.no-accessible-workspace",
        };
      }
      if (options.length === 1) {
        const [option] = options;
        operation = operationStore.updateContext(operationId, {
          expectedRevision: operation.context_revision,
          values: {
            team_id: option.team_id,
            team_name: option.team_name,
            region_name: option.region_name,
          },
          pendingSelection: null,
        });
      } else {
        const pendingSelection = {
          selection_id: randomUUID(),
          dimension: "workspace-region",
          options,
          context_revision: operation.context_revision + 1,
        };
        operationStore.updateContext(operationId, {
          expectedRevision: operation.context_revision,
          pendingSelection,
        });
        return {
          schema: "rainskills.context-result.v1",
          state: "needs-selection",
          selection_id: pendingSelection.selection_id,
          dimension: pendingSelection.dimension,
          options: options.map(({ id, label }) => ({ id, label })),
        };
      }
    }

    return {
      schema: "rainskills.context-result.v1",
      state: "resolved",
      context: clone(operation.context),
      context_revision: operation.context_revision,
    };
  }

  async function select({ operationId, selectionId, optionId } = {}) {
    const operation = operationStore.read(operationId);
    const pending = operation?.pending_selection;
    if (!pending || pending.selection_id !== selectionId
      || pending.context_revision !== operation.context_revision) {
      throw new Error("runtime context selection 已失效");
    }
    const option = pending.options.find((candidate) => candidate.id === optionId);
    if (!option) throw new Error("runtime context option 无效");
    const updated = operationStore.updateContext(operationId, {
      expectedRevision: operation.context_revision,
      values: {
        team_id: option.team_id,
        team_name: option.team_name,
        region_name: option.region_name,
      },
      pendingSelection: null,
    });
    return {
      schema: "rainskills.context-result.v1",
      state: "resolved",
      context: clone(updated.context),
      context_revision: updated.context_revision,
    };
  }

  return { resolve, select };
}

module.exports = {
  createRuntimeContextResolver,
  normalizeWorkspaceOptions,
};

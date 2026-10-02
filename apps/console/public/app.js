/* Myrix 管理后台 —— 无构建依赖的原生实现，由控制面同源托管。
   设计原则：后台只做"治理表达"（谁、对什么、什么条件、以什么方式），
   运行时的执行由 DSH 侧 PEP 插件完成。 */

const state = {
  tab: "overview",
  token: localStorage.getItem("myrix.token") || "dev-admin-token",
  principals: [],
  plugins: [],
  roles: [],
  meta: null,
  selectedPrincipal: "u_1001",
};

const view = () => document.getElementById("view");

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function card(title, ...children) {
  return h("section", { class: "card" }, title ? h("h2", { text: title }) : null, ...children);
}

function badge(text, cls) {
  return h("span", { class: "badge " + (cls || ""), text });
}

function table(headers, rows) {
  return h(
    "table",
    null,
    h("thead", null, h("tr", null, headers.map((header) => h("th", { text: header })))),
    h("tbody", null, rows.map((row) => h("tr", null, row.map((cell) => h("td", null, cell))))),
  );
}

async function api(path, options) {
  const response = await fetch(path, {
    ...(options || {}),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + state.token,
      ...((options && options.headers) || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const reason = body && body.error ? body.error : response.status;
    throw new Error("请求失败：" + reason);
  }
  return body;
}

function principalSelect(onChange) {
  const select = h(
    "select",
    { onchange: (event) => onChange(event.target.value) },
    state.principals.map((principal) =>
      h("option", {
        value: principal.id,
        selected: principal.id === state.selectedPrincipal,
        text: principal.displayName + "（" + principal.id + " · " + principal.department + "）",
      }),
    ),
  );
  return select;
}

function setView(...nodes) {
  const container = view();
  container.replaceChildren(...nodes);
}

function failure(error) {
  setView(card("出错了", h("pre", { text: error instanceof Error ? error.message : String(error) })));
}

/* ---------- 概览 ---------- */

async function renderOverview() {
  const [meta, plugins, entitlements] = await Promise.all([
    api("/api/v1/meta"),
    api("/api/v1/plugins"),
    api("/api/v1/principals/" + state.selectedPrincipal + "/entitlements"),
  ]);
  const highRisk = plugins.items.filter((plugin) => plugin.risk === "high").length;
  const stats = [
    ["租户", meta.tenants.length],
    ["主体", state.principals.length],
    ["插件条目", plugins.stats.total],
    ["高风险功能", highRisk],
    ["角色", state.roles.length],
    ["策略修订", meta.policyRevision],
  ];
  setView(
    card(
      "平台概况",
      h(
        "div",
        { class: "grid" },
        stats.map(([label, value]) =>
          h("div", { class: "stat" }, h("div", { class: "value", text: String(value) }), h("div", { class: "label", text: label })),
        ),
      ),
    ),
    card(
      "与 DSH 的关系",
      h(
        "ul",
        null,
        h("li", { text: "上游仓库（submodule）：" + meta.upstream.repo }),
        h("li", { text: "子模块路径：" + meta.upstream.submodule + "，锁定提交 " + meta.upstream.pinnedRef }),
        h("li", { text: "治理分层：控制面做授权判定（PDP），DSH 插件做执行拦截（PEP），DSH 原生沙箱/审批只作为执行机制。" }),
        h("li", { text: "模型路由与提示词级审计在 LLM 网关完成，本平台只下发模型范围与配额义务。" }),
      ),
    ),
    card(
      "当前演示主体功能裁剪（" + state.selectedPrincipal + "）",
      h("div", { class: "row" }, principalSelect((id) => {
        state.selectedPrincipal = id;
        renderOverview().catch(failure);
      })),
      table(
        ["插件", "类型", "风险", "状态", "原因"],
        entitlements.decisions.map((decision) => {
          const plugin = plugins.items.find((item) => item.id === decision.pluginId) || {};
          return [
            h("span", { class: "mono", text: decision.pluginId }),
            plugin.kind || "-",
            badge(plugin.risk || "-", plugin.risk),
            decision.enabled ? badge("已启用", "allow") : badge("已裁剪", "deny"),
            h("span", { class: "reason", text: decision.reason }),
          ];
        }),
      ),
    ),
  );
}

/* ---------- 身份与角色 ---------- */

async function renderIdentity() {
  const [principals, roles] = await Promise.all([api("/api/v1/principals"), api("/api/v1/roles")]);
  const details = [];
  for (const principal of principals.items) {
    const detail = await api("/api/v1/principals/" + principal.id);
    details.push(detail);
  }
  setView(
    card(
      "主体",
      table(
        ["主体", "类型", "部门", "组", "角色", "权限点"],
        details.map((detail) => [
          h("div", null, h("div", { text: detail.principal.displayName }), h("span", { class: "mono", text: detail.principal.id })),
          detail.principal.kind,
          detail.principal.department || "-",
          detail.principal.groups.join(", "),
          detail.roles.map((roleId) => badge(roleId, "allow")),
          h("span", { class: "mono", text: detail.permissions.join("  ") }),
        ]),
      ),
    ),
    card(
      "角色与权限点（RBAC 第一层：决定“能不能用某类能力”）",
      table(
        ["角色", "继承", "权限点", "说明"],
        roles.items.map((role) => [
          badge(role.name + " / " + role.id, "allow"),
          role.inherits.length > 0 ? role.inherits.join(", ") : "-",
          h("span", { class: "mono", text: role.permissions.join("  ") }),
          h("span", { class: "reason", text: role.description || "" }),
        ]),
      ),
    ),
  );
}

/* ---------- 权限模拟 ---------- */

async function renderSimulate() {
  const actionInput = h("input", { value: "tool:bash", size: 28 });
  const typeInput = h("input", { value: "tool", size: 10 });
  const idInput = h("input", { value: "bash", size: 18 });
  const contextInput = h("textarea", { rows: 4, cols: 48, text: '{\n  "riskScore": 10,\n  "hour": 14\n}' });
  const output = h("div");

  async function run() {
    try {
      const context = JSON.parse(contextInput.value || "{}");
      const result = await api("/api/v1/decisions", {
        method: "POST",
        body: JSON.stringify({
          principalId: state.selectedPrincipal,
          action: actionInput.value,
          resource: { type: typeInput.value, id: idInput.value },
          context,
        }),
      });
      const effect = result.decision.effect === "allow" ? badge("放行", "allow") : badge("拒绝", "deny");
      output.replaceChildren(
        h("h3", null, effect, h("span", { class: "reason", text: "  来源：" + result.source })),
        h("p", { class: "reason", text: result.reason }),
        h("p", null, h("strong", { text: "命中规则：" }), result.decision.matchedRules.join(", ") || "（无）"),
        h("p", { text: "义务（决定“以什么方式执行”）：" }),
        h("pre", { text: JSON.stringify(result.decision.obligations, null, 2) }),
      );
    } catch (error) {
      output.replaceChildren(h("pre", { text: error instanceof Error ? error.message : String(error) }));
    }
  }

  setView(
    card(
      "判定模拟（两级：RBAC 权限点 → ABAC 条件与义务）",
      h("div", { class: "row" }, "主体：", principalSelect((id) => (state.selectedPrincipal = id))),
      h("div", { class: "row" }, "动作：", actionInput, "资源类型：", typeInput, "资源 id：", idInput),
      h("div", { class: "row" }, "上下文：", contextInput),
      h("div", { class: "row" }, h("button", { class: "primary", text: "执行判定", onclick: run })),
    ),
    card("判定结果", output),
  );
  await run();
}

/* ---------- 功能裁剪 ---------- */

async function renderEntitlement() {
  const [entitlements, plugins, profile] = await Promise.all([
    api("/api/v1/principals/" + state.selectedPrincipal + "/entitlements"),
    api("/api/v1/plugins"),
    api("/api/v1/principals/" + state.selectedPrincipal + "/profile"),
  ]);

  const grantPlugin = h(
    "select",
    null,
    plugins.items.map((plugin) => h("option", { value: plugin.id, text: plugin.id + "（" + plugin.kind + "）" })),
  );
  const grantGrantee = h("input", { value: "u_1001", size: 14 });
  const grantResult = h("span", { class: "reason" });
  async function grant() {
    try {
      await api("/api/v1/admin/grants", {
        method: "POST",
        body: JSON.stringify({
          pluginId: grantPlugin.value,
          tenantId: "acme",
          grantee: grantGrantee.value,
          grantedBy: "console:operator",
        }),
      });
      grantResult.textContent = "已授权，正在刷新…";
      await renderEntitlement();
    } catch (error) {
      grantResult.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  setView(
    card(
      "按主体裁剪功能",
      h("div", { class: "row" }, "主体：", principalSelect((id) => {
        state.selectedPrincipal = id;
        renderEntitlement().catch(failure);
      })),
      table(
        ["插件", "类型", "风险", "状态", "原因"],
        entitlements.decisions.map((decision) => {
          const plugin = plugins.items.find((item) => item.id === decision.pluginId) || {};
          return [
            h("span", { class: "mono", text: decision.pluginId }),
            plugin.kind || "-",
            badge(plugin.risk || "-", plugin.risk),
            decision.enabled ? badge("启用", "allow") : badge("关闭", "deny"),
            h("span", { class: "reason", text: decision.reason }),
          ];
        }),
      ),
    ),
    card(
      "插件目录（可裁剪的功能清单）",
      table(
        ["插件", "类型", "风险", "依赖能力", "提供能力", "默认"],
        plugins.items.map((plugin) => [
          h("span", { class: "mono", text: plugin.id }),
          plugin.kind,
          badge(plugin.risk, plugin.risk),
          h("span", { class: "mono", text: plugin.requires.join(", ") || "-" }),
          h("span", { class: "mono", text: plugin.provides.join(", ") || "-" }),
          plugin.defaultEnabled ? "启用" : "关闭",
        ]),
      ),
    ),
    card(
      "新增授权",
      h("div", { class: "row" }, "插件：", grantPlugin, "授权对象（支持 u_xxx / role:xxx / group:xxx）：", grantGrantee,
        h("button", { class: "primary", text: "授权", onclick: grant }), grantResult),
      h("p", { class: "reason", text: "授权只做“加法”；依赖缺失仍会被裁剪，策略 deny 始终优先。" }),
    ),
    card("生成的 DSH profile 补丁（按主体渲染，可直接进入 Harness home）", h("pre", { text: profile.yaml })),
  );
}

/* ---------- 知识库 ---------- */

async function renderKnowledge() {
  const query = h("input", { value: "年假", size: 24 });
  const result = h("div");

  async function load() {
    const payload = await api("/api/v1/knowledge/bases?principalId=" + encodeURIComponent(state.selectedPrincipal));
    return payload;
  }

  async function search() {
    const payload = await api("/api/v1/knowledge/search", {
      method: "POST",
      body: JSON.stringify({ principalId: state.selectedPrincipal, text: query.value, topK: 5 }),
    });
    result.replaceChildren(
      h("p", { class: "reason", text: "实际检索范围：" + payload.searchedBases.join(", ") }),
      payload.errors.length > 0 ? h("pre", { text: JSON.stringify(payload.errors, null, 2) }) : null,
      table(
        ["知识库", "片段", "分数", "来源"],
        payload.chunks.map((chunk) => [
          h("span", { class: "mono", text: chunk.baseId }),
          chunk.text,
          chunk.score.toFixed(2),
          h("span", { class: "reason", text: chunk.uri || (chunk.baseId + "#" + chunk.id) }),
        ]),
      ),
    );
  }

  const payload = await load();
  setView(
    card(
      "知识库联邦：平台只做目录聚合与身份透传，ACL 由知识库自身裁决",
      h("div", { class: "row" }, "主体：", principalSelect((id) => {
        state.selectedPrincipal = id;
        renderKnowledge().catch(failure);
      })),
      table(
        ["知识库", "名称", "提供方", "权限域", "说明"],
        payload.bases.map((base) => [
          h("span", { class: "mono", text: base.id }),
          base.name,
          base.provider,
          base.aclDomain || "-",
          h("span", { class: "reason", text: base.description || "" }),
        ]),
      ),
      payload.errors.length > 0 ? h("pre", { text: JSON.stringify(payload.errors, null, 2) }) : null,
    ),
    card(
      "检索（请求不可见的知识库会被收窄，而不是放行）",
      h("div", { class: "row" }, query, h("button", { class: "primary", text: "检索", onclick: () => search().catch(failure) })),
      result,
    ),
  );
  await search();
}

/* ---------- 审计 ---------- */

async function renderAudit() {
  const payload = await api("/api/v1/audit?limit=80");
  setView(
    card(
      "治理审计事件（模型/提示词级审计在 LLM 网关，通过 traceId 关联）",
      table(
        ["时间", "类别", "主体", "动作", "资源", "结果", "规则", "详情"],
        payload.items.map((event) => [
          h("span", { class: "mono", text: event.ts.slice(11, 19) }),
          event.category,
          event.principalId,
          h("span", { class: "mono", text: event.action }),
          h("span", { class: "mono", text: event.resource }),
          event.effect === "allow" ? badge("allow", "allow") : badge("deny", "deny"),
          h("span", { class: "mono", text: (event.matchedRules || []).join(", ") }),
          h("span", { class: "reason", text: JSON.stringify(event.detail || {}) }),
        ]),
      ),
    ),
  );
}

/* ---------- 网关契约 ---------- */

async function renderGateway() {
  const contract = await api("/api/v1/gateway/contract");
  setView(
    card(
      "边界：" + contract.boundary,
      h("ul", null, contract.responsibilities.map((item) => h("li", { text: item }))),
    ),
    card(
      "请求头约定（治理事件与模型审计共享同一套关联键）",
      table(
        ["Header", "含义"],
        Object.entries(contract.requestHeaders).map(([key, value]) => [h("span", { class: "mono", text: key }), value]),
      ),
    ),
    card("审计关联键", h("pre", { text: JSON.stringify(contract.auditJoinKeys, null, 2) })),
  );
}

/* ---------- 启动 ---------- */

const renderers = {
  overview: renderOverview,
  identity: renderIdentity,
  simulate: renderSimulate,
  entitlement: renderEntitlement,
  knowledge: renderKnowledge,
  audit: renderAudit,
  gateway: renderGateway,
};

async function show(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll("#tabs button")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
  try {
    await renderers[tab]();
  } catch (error) {
    failure(error);
  }
}

async function reloadBase() {
  const [principals, plugins, roles] = await Promise.all([
    api("/api/v1/principals"),
    api("/api/v1/plugins"),
    api("/api/v1/roles"),
  ]);
  state.principals = principals.items;
  state.plugins = plugins.items;
  state.roles = roles.items;
  if (!state.principals.some((principal) => principal.id === state.selectedPrincipal)) {
    state.selectedPrincipal = state.principals[0] ? state.principals[0].id : "";
  }
}

document.getElementById("tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button) void show(button.dataset.tab);
});

document.getElementById("token").addEventListener("change", (event) => {
  state.token = event.target.value;
  localStorage.setItem("myrix.token", state.token);
  void bootstrap();
});

document.getElementById("refresh").addEventListener("click", () => void bootstrap());

async function bootstrap() {
  try {
    await reloadBase();
    await show(state.tab);
  } catch (error) {
    failure(error);
  }
}

void bootstrap();

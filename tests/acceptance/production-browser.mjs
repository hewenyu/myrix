// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * 生产 HTTPS + 同机 Keycloak OIDC 的**浏览器登录与最小持久化 smoke**。
 *
 * 这个 runner 只负责"未来 GitHub Actions 正式镜像"上线后由人工在真实 VPS 上执行的
 * 两层验收：
 *   1) 生产登录：真实前端 OIDC 按钮（“登录我的书架”）→ 真实 Keycloak 登录表单 → BFF
 *      `/api/v1/auth/callback`（Authorization Code + PKCE(S256)，走 standard flow）；
 *   2) 最小存储 smoke：用已授权的工作台 UI 创建一本明确标注验收前缀的作品
 *      （书架 → 新建书本 → 书名/简介 → 创建并开始写作），保存一段最小章节正文，刷新页面确认持久。
 *
 * 会话生命周期 smoke（创建 → 有界确认 active → 撤权 204）**不经过 UI 发送消息**：
 * 新版统一创作 Agent 没有 preset grid，会话只在首条消息发送时创建，而发送必然触发真实模型
 * 回合——生产验收明确禁止发送模型请求（见下）。因此会话由**同源已认证的公开 API**创建，
 * 随后仍在真实 UI 的历史对话里选中该会话并用“永久结束对话”撤权；全程不触碰消息端点。
 *
 * 它**不**重复 `tests/acceptance/local-browser.mjs` / `business-journey.mjs` 的完整业务链路，
 * 也**不**发送任何模型请求（真实模型 + 完整工具的验收由 Lead 用现有 runner 负责）。
 *
 * 硬性约束（与仓库部署安全要求一致）：
 *   - 只有显式 `MYRIX_ACCEPTANCE_ALLOW_MUTATION=1` 才启动浏览器；否则在启动前拒绝，
 *     因为本 runner 会创建一件带验收前缀的作品；
 *   - 只走真实 UI：绝不 admin bypass / 伪造 cookie / 关 realm 的 required action /
 *     direct access grant / ROPC；
 *   - `UPDATE_PASSWORD` 需要显式 `MYRIX_ACCEPTANCE_NEW_PASSWORD`，否则脱敏失败；
 *     需要补充 email / 个人信息等 `UPDATE_PROFILE` 字段时同样脱敏失败并要求人工完成，
 *     绝不发明个人信息；
 *   - 提交新口令前必须严格校验页面仍是**同源 + 精确 required-action 路径**；一旦提交，
 *     改密进度立即以 `passwordChangeAttempted` / `passwordChangeUncertain` 写进脱敏报告，
 *     后续即使 `UPDATE_PROFILE`、BFF callback 或网络失败也只保留 uncertain，绝不谎称未修改；
 *     新口令绝不写盘、绝不进入报告，Lead 私下保留原/候选两份直至确认；
 *   - 浏览器 context 锁定到显式 origin：任何跨 origin 的 http(s) 请求（尤其是带凭据的
 *     表单跳转）一律中止，并作为显式失败上报（不输出目标 URL）；本部署所有资源同 origin；
 *   - stdout/stderr 只输出固定步骤名、状态、非敏感 id 与用户名；绝不输出密码、cookie、
 *     token、OIDC code、含查询串的 URL，也绝不原样打印 Playwright Error（locator 错误
 *     可能带 URL 或输入值）；所有失败统一为固定脱敏错误 + exit 1；
 *   - 禁用 trace / video / 登录截图 / console / 网络日志，绝不持久化 browser storageState；
 *   - 默认无运行副作用：导入本模块不启动浏览器、不读环境变量、不写文件；
 *     只有直接 CLI 执行才进入 `main()`。
 *
 * 输入（全部通过明确命名的环境变量）：
 *   - MYRIX_ACCEPTANCE_ORIGIN             必填，显式 HTTPS origin（无路径/凭据/查询/片段）
 *   - MYRIX_ACCEPTANCE_USERNAME           必填，Keycloak 用户名（默认 myrix-owner）
 *   - MYRIX_ACCEPTANCE_PASSWORD           必填，当前密码
 *   - MYRIX_ACCEPTANCE_NEW_PASSWORD       可选，仅首次 `UPDATE_PASSWORD` 时需要
 *   - MYRIX_ACCEPTANCE_ALLOW_MUTATION     必须为 "1" 才启动浏览器
 *   - MYRIX_ACCEPTANCE_SCREENSHOT_DIR     可选，成功后工作台截图目录；必须是仓库 `data/` 下路径
 *
 * 运行：MYRIX_ACCEPTANCE_ALLOW_MUTATION=1 MYRIX_ACCEPTANCE_ORIGIN=https://<host> \
 *       MYRIX_ACCEPTANCE_USERNAME=myrix-owner MYRIX_ACCEPTANCE_PASSWORD=... \
 *       node tests/acceptance/production-browser.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 验收作品/章节的显式前缀：人工在数据库或工作台里一眼可辨，绝不与真实创作混淆。 */
export const ACCEPTANCE_TITLE_PREFIX = 'MYRIX-ACCEPTANCE-';
export const ACCEPTANCE_CHAPTER_PREFIX = 'MYRIX-ACCEPTANCE-CH-';

/** 同机 Keycloak 的固定部署契约：KC_HTTP_RELATIVE_PATH=/auth，realm=myrix。 */
export const KEYCLOAK_LOGIN_PATH = '/auth/realms/myrix/protocol/openid-connect/auth';
export const KEYCLOAK_AUTHENTICATE_PATH = '/auth/realms/myrix/login-actions/authenticate';
export const KEYCLOAK_REQUIRED_ACTION_PATH = '/auth/realms/myrix/login-actions/required-action';

/** 输入环境变量名，全部显式命名。 */
export const ENV = Object.freeze({
  origin: 'MYRIX_ACCEPTANCE_ORIGIN',
  username: 'MYRIX_ACCEPTANCE_USERNAME',
  password: 'MYRIX_ACCEPTANCE_PASSWORD',
  newPassword: 'MYRIX_ACCEPTANCE_NEW_PASSWORD',
  allowMutation: 'MYRIX_ACCEPTANCE_ALLOW_MUTATION',
  screenshotDir: 'MYRIX_ACCEPTANCE_SCREENSHOT_DIR',
});

/**
 * 所有对外可见的错误文本都是**固定常量**，绝不包含任何输入值。
 * `AcceptanceError` 只接受 code，message 永远从这张表里取，从根上杜绝 secret 回显。
 */
const SAFE_MESSAGES = Object.freeze({
  mutation_not_allowed: '拒绝启动浏览器：必须显式设置 MYRIX_ACCEPTANCE_ALLOW_MUTATION=1（本验收会创建标明验收的作品）',
  origin_missing: '缺少 MYRIX_ACCEPTANCE_ORIGIN；必须是显式 HTTPS origin',
  origin_invalid: 'MYRIX_ACCEPTANCE_ORIGIN 不是合法 URL',
  origin_not_https: 'MYRIX_ACCEPTANCE_ORIGIN 必须是 HTTPS origin',
  origin_has_credentials: 'MYRIX_ACCEPTANCE_ORIGIN 不得包含用户名或口令',
  origin_has_query: 'MYRIX_ACCEPTANCE_ORIGIN 不得包含查询串或片段',
  origin_has_path: 'MYRIX_ACCEPTANCE_ORIGIN 不得包含路径',
  origin_not_canonical: 'MYRIX_ACCEPTANCE_ORIGIN 必须是规范 origin（例如 https://host，无尾斜杠）',
  username_missing: '缺少 MYRIX_ACCEPTANCE_USERNAME',
  password_missing: '缺少 MYRIX_ACCEPTANCE_PASSWORD',
  screenshot_dir_outside_data: 'MYRIX_ACCEPTANCE_SCREENSHOT_DIR 必须位于仓库 data/ 目录下（该目录已被 .gitignore 覆盖）',
  not_oidc_mode: '目标不是 OIDC 模式，拒绝在生产验收里继续',
  development_identity_visible: '登录页暴露了开发身份入口，拒绝继续',
  development_login_available: '服务端仍接受开发登录，拒绝继续',
  idp_unexpected_page: '未跳转到预期的 Keycloak realm 登录页',
  idp_unexpected_required_action: '改密页不是预期的同源 Keycloak required-action 路径，拒绝填写新口令',
  external_navigation_blocked: '检测到主框架跳往外部 origin，已由请求锁中止（目标 URL 不输出）',
  idp_form_field_missing: 'Keycloak 表单缺少预期的稳定字段',
  idp_submit_missing: 'Keycloak 表单缺少可提交按钮',
  idp_error: 'Keycloak 拒绝了本次登录（用户名/口令或账号状态），原始错误已脱敏',
  new_password_required: '首次登录需要 UPDATE_PASSWORD，但未提供 MYRIX_ACCEPTANCE_NEW_PASSWORD',
  password_change_rejected: 'Keycloak 拒绝了新口令（可能不满足口令策略）',
  manual_profile_required: 'Keycloak 要求补充个人信息（UPDATE_PROFILE）；本 runner 不发明 email/个人信息，需人工完成后重跑',
  login_timeout: '等待 OIDC 登录流程结束超时',
  callback_rejected: 'BFF 回调未建立会话（身份未预置、成员停用或 OIDC 校验失败）',
  session_missing: '登录后 GET /api/v1/auth/session 未返回已认证会话',
  session_invalid: '会话响应不是 OIDC 认证会话',
  work_create_failed: '通过工作台 UI 创建验收作品失败',
  chapter_create_failed: '通过工作台 UI 创建验收章节失败',
  chapter_save_failed: '通过工作台 UI 保存验收章节失败',
  chapter_not_persisted: '刷新前经同源 API 读取章节正文与提交内容不一致',
  chapter_not_visible_after_reload: '刷新页面后章节正文未从服务端恢复',
  session_create_failed: '通过同源已认证公开 API 创建助手会话失败（统一 Agent 的 UI 只在发送首条消息时建会话，而生产验收不得发送模型请求）',
  session_select_failed: '未能在真实 UI 的历史对话里唯一选中刚创建的验收会话',
  session_activation_timeout: '创建会话后未在有界时间内观测到 active；拒绝撤销一个未激活的会话',
  session_activation_invalid: '同源会话列表未包含刚创建的会话 id（或响应不可解析）；拒绝继续',
  session_already_revoked: '刚创建的会话已是 revoked/closed 状态；拒绝把本次验收标记为通过',
  session_revoke_failed: '撤销助手会话未返回 204；会话可能仍然有效，拒绝把本次验收标记为通过',
  unexpected_model_activity: '未发送任何模型请求，但会话里出现了消息',
  unexpected_error: '浏览器或平台验收失败；原始错误已按策略脱敏（不含 Playwright/网络细节）',
});

/** 只携带固定文本的验收错误。 */
export class AcceptanceError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.unexpected_error);
    this.name = 'AcceptanceError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* 纯函数：输入校验 / URL 契约 / 脱敏（可离线单测）                     */
/* ------------------------------------------------------------------ */

/** 必须是显式、规范、无路径/凭据/查询的 HTTPS origin。 */
export function parseAcceptanceOrigin(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new AcceptanceError('origin_missing');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AcceptanceError('origin_invalid');
  }
  if (parsed.protocol !== 'https:') throw new AcceptanceError('origin_not_https');
  if (parsed.username || parsed.password) throw new AcceptanceError('origin_has_credentials');
  if (parsed.search || parsed.hash) throw new AcceptanceError('origin_has_query');
  if (parsed.pathname !== '/') throw new AcceptanceError('origin_has_path');
  if (parsed.origin !== raw) throw new AcceptanceError('origin_not_canonical');
  return parsed.origin;
}

/** 默认无副作用：没有显式确认就不允许启动浏览器。 */
export function assertMutationAllowed(env) {
  if (env[ENV.allowMutation] !== '1') throw new AcceptanceError('mutation_not_allowed');
}

/** 完整读入并校验验收输入；任何拒绝都只返回固定脱敏错误。 */
export function validateAcceptanceEnv(env) {
  assertMutationAllowed(env);
  const origin = parseAcceptanceOrigin(env[ENV.origin]);
  const username = requireNonEmpty(env[ENV.username], 'username_missing');
  const password = requireNonEmpty(env[ENV.password], 'password_missing');
  const newPassword = typeof env[ENV.newPassword] === 'string' && env[ENV.newPassword].length > 0
    ? env[ENV.newPassword]
    : null;
  return { origin, username, password, newPassword };
}

function requireNonEmpty(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw new AcceptanceError(code);
  return value;
}

/**
 * 是否为预期的同机 Keycloak realm 登录页。
 *
 * 两种真实形态都接受：
 *   - 授权端点 `/auth/realms/myrix/protocol/openid-connect/auth`：必须**精确匹配该 pathname**
 *     （不接受子路径/后缀），并带真实 `response_type=code` 与 `code_challenge_method=S256`；
 *   - 登录动作端点 `/auth/realms/myrix/login-actions/authenticate`（Keycloak
 *     渲染表单/重定向时可能出现），只要求同源 + 该精确路径。
 *
 * "是否真的是 Keycloak 登录表单"最终由稳定字段 `input[name=username]` /
 * `input[name=password]` 兜底，不靠推断。
 */
export function isKeycloakLoginUrl(raw, origin) {
  try {
    const url = new URL(raw);
    if (url.origin !== origin) return false;
    if (url.pathname === KEYCLOAK_AUTHENTICATE_PATH) return true;
    if (url.pathname !== KEYCLOAK_LOGIN_PATH) return false;
    return url.searchParams.get('response_type') === 'code'
      && url.searchParams.get('code_challenge_method') === 'S256';
  } catch {
    return false;
  }
}

/** 是否为同机 Keycloak 的 required-action 页（首次改密 / 个人信息补齐都在这里）。 */
export function isKeycloakRequiredActionUrl(raw, origin) {
  try {
    const url = new URL(raw);
    return url.origin === origin && url.pathname === KEYCLOAK_REQUIRED_ACTION_PATH;
  } catch {
    return false;
  }
}

/**
 * 任何填写新口令之前，页面必须仍是**同源 + 精确 required-action 路径**。
 * 这是纯校验：只抛固定 code，绝不回显页面 URL（可能含查询串）。
 */
export function assertPasswordUpdatePage(raw, origin) {
  if (!isKeycloakRequiredActionUrl(raw, origin)) throw new AcceptanceError('idp_unexpected_required_action');
  return true;
}

/**
 * 浏览器 context 的精确 origin 锁：只放行显式 origin 的 http(s) 请求，
 * 其余（尤其是带凭据的表单跳往外部 origin）一律判定为应中止。
 * 非网络协议（about:/data:/blob: 等）不属于本锁范围。
 */
export function shouldBlockExternalRequest(raw, origin) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.origin !== origin;
  } catch {
    return false;
  }
}

/**
 * 改密进度的**纯状态机**：不碰浏览器、不碰磁盘、不持有口令，
 * 只记录"是否在提交新口令前就登记了尝试、结果是否仍未确认"。
 *
 * 语义：
 *   - `submitting`：新口令即将提交（在 submit 之前调用），attempted=true 且 uncertain=true，
 *     因为从这一刻起 Keycloak 可能已经落库，本 runner 无法再声称"未修改"；
 *   - `confirmed`：随后看到 workbench 或 profile-update，说明改密已生效，
 *     uncertain=false（即使 profile-update 紧接着要求人工，也必须保留已确认状态）；
 *   - `uncertain`：callback 拒绝/超时/表单报错等，保留 attempted=true + uncertain=true。
 */
export function createPasswordChangeProgress() {
  return Object.freeze({ attempted: false, uncertain: false });
}

export function applyPasswordChangeProgress(progress, event) {
  const base = progress ?? createPasswordChangeProgress();
  if (event === 'submitting') return Object.freeze({ attempted: true, uncertain: true });
  if (!base.attempted) return base;
  if (event === 'confirmed') return Object.freeze({ attempted: true, uncertain: false });
  if (event === 'uncertain') return base;
  return base;
}

/**
 * 浏览器流程使用的进度跟踪器：纯状态函数的薄包装，**即使后续抛错**，
 * `main()` 仍能从 `tracker.state` 读到"提交已发生且结果未确认"的真相。
 */
export function createPasswordProgressTracker() {
  let state = createPasswordChangeProgress();
  return {
    get state() {
      return state;
    },
    record(event) {
      state = applyPasswordChangeProgress(state, event);
      return state;
    },
  };
}

/** 把内部进度折叠成报告字段：只有"已尝试且不再不确定"才算 passwordChanged=true。 */
export function passwordChangeReport(progress) {
  const attempted = progress?.attempted === true;
  const uncertain = attempted && progress?.uncertain === true;
  return {
    passwordChanged: attempted && !uncertain,
    passwordChangeAttempted: attempted,
    passwordChangeUncertain: uncertain,
  };
}

/**
 * 会话撤销是否真的成功：只有 204 才算成功。
 *
 * 这是纯校验：非 204（含缺失/异常的响应对象）一律抛固定 code `session_revoke_failed`，
 * 绝不允许"撤销失败但仍然 passed=true"的验收结果。绝不回显响应体/状态以外的任何原文。
 */
export function assertSessionRevoked(response) {
  if (!response || response.status !== 204) throw new AcceptanceError('session_revoke_failed');
  return true;
}

/**
 * 会话激活轮询的有界参数。
 *
 * 为什么需要它：`POST /api/v1/works/:workId/sessions` 返回 201 只表示"绑定 + create
 * 命令已持久入队"（`status: creating`）——真正的激活发生在 create 命令拿到 cell 回执
 * 之后。旧 runner 在 201 之后立刻 DELETE，撤销的是一个**尚未激活**的会话，
 * 验收结论与生产语义不符。这里只在**同源已认证**的 `GET .../sessions` 上确认
 * 精确 created sid 达到 `active` 之后才允许撤销。
 *
 * 必须**有界**：一直等不到 active 就超时失败，绝不把"没激活"当成"可以撤销"。
 */
export const SESSION_ACTIVATION_TIMEOUT_MS = 30_000;
export const SESSION_ACTIVATION_POLL_MS = 500;

/** 同源会话列表路径；只接受 UUID 形态的作品 id（防注入/拼接）。 */
export function sessionsListPath(workId) {
  if (typeof workId !== 'string' || !UUID.test(workId)) throw new AcceptanceError('session_activation_invalid');
  return `/api/v1/works/${workId}/sessions`;
}

/**
 * 把一次会话列表响应折叠成**精确**结论（纯函数，可离线单测）。
 *
 * 判据只有 created sid 自己那一条：
 *   * `active`   —— 该 id 存在且状态为 `active`（唯一放行结论）；
 *   * `creating` —— 该 id 存在但仍在创建中（继续有界轮询）；
 *   * `revoked`  —— 该 id 已是 `revoked`/`closed`（终止失败，绝不"撤销一个已撤销的"）；
 *   * `unknown`  —— 列表里没有该 id（含"别的会话 active"这种非匹配情况）；
 *   * `invalid`  —— 响应结构不可解析（终止失败，绝不推断）。
 *
 * 刻意**不**把"列表里有任何一条 active"当成通过：必须是自己刚创建的那一条。
 */
export function classifySessionActivation(payload, expectedId) {
  if (typeof expectedId !== 'string' || expectedId.length === 0) return 'invalid';
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) return 'invalid';
  const match = payload.items.find(item => item && typeof item === 'object' && item.id === expectedId);
  if (!match) return 'unknown';
  if (match.status === 'active') return 'active';
  if (match.status === 'creating') return 'creating';
  if (match.status === 'revoked' || match.status === 'closed') return 'revoked';
  return 'invalid';
}

/**
 * 有界等待刚创建的会话达到 `active`。
 *
 * 依赖全部注入（`fetchList` 返回 `{ status, json() }` 形状的响应、`now`/`sleep` 计时），
 * 因此可以离线单测；真实调用传同源 `context.request.get`，且必须带 `maxRedirects: 0`。
 *
 * 终止语义：
 *   * `active`                       → 返回 `'active'`；
 *   * `revoked`                      → 固定 code `session_already_revoked`；
 *   * `invalid`                      → 固定 code `session_activation_invalid`；
 *   * 网络失败/**任何非 200**（含 3xx；调用方以 `maxRedirects: 0` 保证重定向不会被
 *     自动跟随、而是原样暴露成非 200）/`unknown`/`creating` → 继续轮询，超过 deadline
 *     抛 `session_activation_timeout`。绝不把"没确认"当成通过。
 */
export async function waitForSessionActivation(input) {
  const timeoutMs = input.timeoutMs ?? SESSION_ACTIVATION_TIMEOUT_MS;
  const pollMs = input.pollMs ?? SESSION_ACTIVATION_POLL_MS;
  const deadline = input.now() + timeoutMs;
  for (;;) {
    let verdict;
    try {
      const response = await input.fetchList();
      if (!response || response.status !== 200) {
        verdict = 'unknown';
      } else {
        verdict = classifySessionActivation(await response.json().catch(() => null), input.expectedId);
      }
    } catch {
      // 网络/解析异常：按"尚未确认"继续有界轮询，绝不在这里下任何放行结论。
      verdict = 'unknown';
    }
    if (verdict === 'active') return 'active';
    if (verdict === 'revoked') throw new AcceptanceError('session_already_revoked');
    if (verdict === 'invalid') throw new AcceptanceError('session_activation_invalid');
    if (input.now() >= deadline) throw new AcceptanceError('session_activation_timeout');
    await input.sleep(pollMs);
  }
}

/** 只取 pathname：绝不让带查询串（可能含 code/state）的 URL 进入任何输出。 */
export function safePathname(raw) {
  try {
    return new URL(raw).pathname;
  } catch {
    return '';
  }
}

/**
 * 把任意错误折叠成固定脱敏结构；绝不透传 Playwright/网络原始文本。
 *
 * 注意：这里**只按 code 从固定文案表重建 message**，绝不使用 `error.message`
 * ——即使某个 `AcceptanceError` 实例的 message 事后被改写，也不会把值带出去。
 */
export function redactError(error) {
  if (error instanceof AcceptanceError && typeof error.code === 'string' && Object.hasOwn(SAFE_MESSAGES, error.code)) {
    return { code: error.code, message: SAFE_MESSAGES[error.code] };
  }
  return { code: 'unexpected_error', message: SAFE_MESSAGES.unexpected_error };
}

/** 截图目录必须是仓库 data/ 之下的路径（该目录被 .gitignore 覆盖）。 */
export function resolveScreenshotDir(raw, repoRoot = root) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const resolved = resolve(repoRoot, raw);
  const dataRoot = resolve(repoRoot, 'data');
  if (resolved !== dataRoot && !resolved.startsWith(dataRoot + sep)) {
    throw new AcceptanceError('screenshot_dir_outside_data');
  }
  return resolved;
}

/** 只有直接 CLI 执行才进入 main；被 import 时绝不产生副作用。 */
export function isDirectRun(moduleUrl, argv1) {
  if (typeof argv1 !== 'string' || argv1.length === 0) return false;
  try {
    return moduleUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 浏览器侧帮助函数（导入时不执行）                                     */
/* ------------------------------------------------------------------ */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 只保留操作系统变量；绝不把环境里的 secret 透进 Chromium。
 * 与 `tests/acceptance/local-browser.mjs` 保持同一份白名单，不额外猜测代理/CA 变量。
 */
function browserEnv(env) {
  const keys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR'];
  return Object.fromEntries(keys.flatMap(key => (env[key] === undefined ? [] : [[key, env[key]]])));
}

function pathnameOf(raw) {
  return safePathname(raw);
}

/** 等一个精确到 pathname+方法的响应，并只回传状态与非敏感 JSON body。 */
async function withResponse(page, pathname, method, action) {
  const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() === method && pathnameOf(r.url()) === pathname, { timeout: 45_000 }),
    action(),
  ]);
  return { status: response.status(), body: await response.json().catch(() => null) };
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return locator;
  }
  return null;
}

/** 登录后的唯一入口是书架（`<main aria-label="我的书架">`，角色按 HTML-AAM 是 main）。 */
function shelfOf(page) {
  return page.getByRole('main', { name: '我的书架', exact: true });
}

/** 打开书的唯一显式动作是封面按钮 `aria-label="打开书本：<title>"`。 */
async function openBook(page, bookTitle) {
  await shelfOf(page).getByRole('button', { name: `打开书本：${bookTitle}`, exact: true }).click();
}

/**
 * 章节新建表单在有章节时默认收起；展开态只渲染提交按钮、收起态只渲染同名开关。
 * 先看标题输入框在不在，不在就先点开开关，避免同名按钮歧义。
 */
async function openChapterCreateForm(page) {
  const input = page.getByLabel('新章节标题', { exact: true });
  if (!(await input.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '新建章节', exact: true }).click();
  }
  await input.waitFor();
  return input;
}

/**
 * 统一 Agent 的会话只在首条消息发送时创建，而生产验收不得发送模型请求。
 * 因此用**同源已认证的公开 API**（浏览器 context 自带的 cookie jar + `GET /auth/session`
 * 里的 CSRF，绝不伪造凭据）创建 novel-assistant 会话；返回 `{ status, body }` 形状，
 * 与 `withResponse` 一致，便于沿用既有的捕获/断言路径。
 */
async function createAcceptanceSession(context, origin, workId) {
  const authSession = await context.request.get(`${origin}/api/v1/auth/session`, { maxRedirects: 0, timeout: 15_000 });
  const csrf = authSession.status() === 200 ? (await authSession.json().catch(() => null))?.csrfToken : null;
  if (typeof csrf !== 'string' || csrf.length === 0) return { status: 0, body: null };
  const response = await context.request.post(`${origin}/api/v1/works/${workId}/sessions`, {
    headers: { origin, 'content-type': 'application/json', 'x-csrf-token': csrf },
    data: { preset: 'novel-assistant' },
    maxRedirects: 0,
    timeout: 15_000,
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

/**
 * 在真实 UI 里选中刚创建的验收会话：历史对话默认收起 → 展开 → 刷新列表 →
 * 点“创作 Agent · 1”（新作品里唯一一条，标题 + 序号 + 时间，不展示 uuid）。
 */
async function selectAcceptanceSession(page) {
  const historyToggle = page.getByRole('button', { name: '历史对话', exact: true });
  if ((await historyToggle.getAttribute('aria-expanded')) !== 'true') await historyToggle.click();
  const history = page.locator('.conversation-history');
  await history.waitFor();
  await history.getByRole('button', { name: '刷新', exact: true }).click();
  const item = history.getByRole('button').filter({ hasText: '创作 Agent · 1' }).first();
  const listed = await item.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  if (!listed) throw new AcceptanceError('session_select_failed');
  await item.click();
  await page.locator('.session-options').waitFor();
}

async function submitKeycloakForm(page) {
  const submit = await firstVisible(page, ['#kc-login', 'input[name="login"]', 'button[type="submit"]', 'input[type="submit"]']);
  if (!submit) throw new AcceptanceError('idp_submit_missing');
  await submit.click();
}

/** 在一次提交后等待三种终局之一：回到应用、要求改密、要求补个人信息。 */
async function waitForIdpOutcome(page, origin, external) {
  // 外部 origin 跳转已被请求锁中止：这是显式失败，绝不折叠成普通超时。
  if (external?.blocked) return 'external-navigation';
  const state = await page.waitForFunction(({ origin: appOrigin }) => {
    const sameHost = location.origin === appOrigin;
    if (sameHost && location.pathname === '/') return 'workbench';
    if (document.querySelector('#kc-passwd-update-form, input[name="password-new"]')) return 'password-update';
    if (document.querySelector('input[name="email"], input[name="firstName"], input[name="lastName"]')) return 'profile-update';
    if (document.querySelector('#kc-error-message .kc-feedback-text, .alert-error, #input-error, [role="alert"]')) return 'idp-error';
    return false;
  }, { origin }, { timeout: 45_000, polling: 250 }).then(handle => handle.jsonValue()).catch(() => null);
  if (state) return state;
  if (external?.blocked) return 'external-navigation';
  // 区分"BFF 回调拒绝"与"IdP 一直没给出终局"：只看 pathname，不看查询串。
  return safePathname(page.url()).startsWith('/api/v1/auth/') ? 'callback-error' : 'login-timeout';
}

/** 处理 Keycloak 首次改密页：优先稳定 name，回退到表单内密码字段顺序。 */
export async function fillPasswordUpdate(page, newPassword) {
  const namedNew = page.locator('input[name="password-new"]').first();
  const namedConfirm = page.locator('input[name="password-confirm"]').first();
  const hasNamed = (await namedNew.count()) > 0 && (await namedConfirm.count()) > 0;
  if (hasNamed) {
    await namedNew.fill(newPassword);
    await namedConfirm.fill(newPassword);
    return;
  }
  const inputs = page.locator('#kc-passwd-update-form input[type="password"]');
  if ((await inputs.count()) < 2) throw new AcceptanceError('idp_form_field_missing');
  await inputs.nth(0).fill(newPassword);
  await inputs.nth(1).fill(newPassword);
}

/**
 * 真实 OIDC 登录：前端按钮 → 真实 Keycloak 表单 → 处理 UPDATE_PASSWORD。
 *
 * 改密进度在**提交新口令之前**就写进 tracker：一旦提交，本 runner 无法再排除
 * "Keycloak 已落库但下一步被拒/超时"的可能，因此只能报 uncertain，
 * 绝不谎称未修改。新口令只活在内存里，绝不写盘、绝不进报告。
 */
export async function performOidcLogin(page, input, tracker = createPasswordProgressTracker(), external = null) {
  const usernameField = page.locator('input[name="username"]').first();
  await usernameField.waitFor({ timeout: 45_000 });
  if (!isKeycloakLoginUrl(page.url(), input.origin)) throw new AcceptanceError('idp_unexpected_page');
  await usernameField.fill(input.username);
  const passwordField = page.locator('input[name="password"]').first();
  if ((await passwordField.count()) === 0) throw new AcceptanceError('idp_form_field_missing');
  await passwordField.fill(input.password);
  await submitKeycloakForm(page);

  let outcome = await waitForIdpOutcome(page, input.origin, external);
  const externalFailure = () => new AcceptanceError('external_navigation_blocked');

  if (outcome === 'password-update') {
    if (!input.newPassword) throw new AcceptanceError('new_password_required');
    // 填写任何新口令之前：必须是同源 + 精确 required-action 路径。
    assertPasswordUpdatePage(page.url(), input.origin);
    await fillPasswordUpdate(page, input.newPassword);
    // 提交前登记：从这一刻起改密结果不确定。
    tracker.record('submitting');
    await submitKeycloakForm(page);
    if (external?.blocked) {
      tracker.record('uncertain');
      throw externalFailure();
    }
    const next = await waitForIdpOutcome(page, input.origin, external);
    if (next === 'workbench' || next === 'profile-update') {
      // 改密已被 Keycloak 接受（下一步要求补个人信息也算已接受），随后即使人工抛错也保留。
      tracker.record('confirmed');
      if (next === 'profile-update') throw new AcceptanceError('manual_profile_required');
      outcome = next;
    } else {
      // 明确拒绝可视为未确认；callback/网络失败只能报 uncertain。
      tracker.record('uncertain');
      if (next === 'password-update') throw new AcceptanceError('password_change_rejected');
      if (next === 'idp-error') throw new AcceptanceError('idp_error');
      if (next === 'external-navigation') throw externalFailure();
      throw new AcceptanceError(next === 'callback-error' ? 'callback_rejected' : 'login_timeout');
    }
  } else if (outcome === 'profile-update') {
    throw new AcceptanceError('manual_profile_required');
  } else if (outcome === 'idp-error') {
    throw new AcceptanceError('idp_error');
  } else if (outcome === 'external-navigation') {
    throw externalFailure();
  } else if (outcome !== 'workbench') {
    throw new AcceptanceError(outcome === 'callback-error' ? 'callback_rejected' : 'login_timeout');
  }
  return tracker;
}

/** 开发登录必须已经不可用：用独立上下文探测，绝不污染主页面的会话。 */
async function assertDevLoginDisabled(browser, origin) {
  const probe = await browser.newContext();
  try {
    const response = await probe.request.post(`${origin}/api/v1/auth/dev-login`, {
      headers: { origin },
      data: { user: 'author' },
      maxRedirects: 0,
      timeout: 15_000,
    });
    if (response.status() !== 404) throw new AcceptanceError('development_login_available');
  } finally {
    await probe.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 执行生产登录 + 最小存储 smoke。
 * @returns {Promise<object>} 脱敏报告（含 passed / 非敏感实体 id / 固定检查项）。
 */
export async function main(env = process.env) {
  const steps = [];
  const report = {
    runner: 'production-browser',
    origin: null,
    username: null,
    steps,
    checks: [],
    workId: null,
    chapterId: null,
    sessionId: null,
    sessionCreatedVia: null,
    sessionActivation: null,
    sessionRevoked: false,
    passwordChanged: false,
    passwordChangeAttempted: false,
    passwordChangeUncertain: false,
    modelRequestsSent: 0,
    mode: null,
    screenshots: [],
    passed: false,
    error: null,
  };
  let step = 'validate-input';
  let browser = null;
  let runDir = null;
  // 改密进度发生在浏览器流程里，但**即使流程抛错**也必须能写进报告。
  const passwordProgress = createPasswordProgressTracker();
  const syncPasswordReport = () => {
    Object.assign(report, passwordChangeReport(passwordProgress.state));
  };
  const mark = (name, status = 'ok') => {
    steps.push(`${name}:${status}`);
    process.stdout.write(`production-browser step=${name} status=${status}\n`);
  };

  try {
    const input = validateAcceptanceEnv(env);
    const screenshotDir = resolveScreenshotDir(env[ENV.screenshotDir]);
    report.origin = input.origin;
    report.username = input.username;
    mark('validate-input');

    const run = `${Date.now()}`;
    runDir = resolve(root, 'data/acceptance', `production-browser-${run}`);
    await mkdir(runDir, { recursive: true, mode: 0o700 });

    step = 'launch-browser';
    const { chromium } = await import('playwright');
    // 无 trace / video / storageState：浏览器状态只存在于这次内存上下文里。
    browser = await chromium.launch({ headless: true, env: browserEnv(env) });
    mark('launch-browser');

    step = 'verify-oidc-config';
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' });
    // 精确 origin 锁：本部署所有静态资源同 origin，任何跨 origin 的 http(s) 请求
    // （尤其是带凭据的表单跳转）一律中止，并只记录布尔标志、绝不回显目标 URL。
    const external = { blocked: false };
    await context.route('**/*', route => {
      if (shouldBlockExternalRequest(route.request().url(), input.origin)) {
        external.blocked = true;
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    const configResponse = await context.request.get(`${input.origin}/api/v1/auth/config`, { maxRedirects: 0, timeout: 15_000 });
    const config = await configResponse.json().catch(() => null);
    if (configResponse.status() !== 200 || config?.mode !== 'oidc') throw new AcceptanceError('not_oidc_mode');
    report.mode = config.mode;
    mark('verify-oidc-config');

    step = 'open-login';
    await page.goto(input.origin, { waitUntil: 'domcontentloaded' });
    await page.getByRole('region', { name: '登录', exact: true }).waitFor();
    if ((await page.getByRole('button', { name: '作者 author', exact: true }).count()) !== 0) {
      throw new AcceptanceError('development_identity_visible');
    }
    mark('open-login');

    step = 'oidc-login';
    await Promise.all([
      page.waitForURL(url => url.origin === input.origin && url.pathname.startsWith('/auth/realms/myrix/'), { timeout: 45_000 }).catch(() => null),
      page.getByRole('button', { name: '登录我的书架', exact: true }).click(),
    ]);
    // 无论 performOidcLogin 成功还是抛错，都把进度折叠进报告（finally 里也再同步一次）。
    const progress = await performOidcLogin(page, input, passwordProgress, external);
    Object.assign(report, passwordChangeReport(progress.state));
    report.checks.push('Real workbench OIDC button drove a real Keycloak form (standard code + PKCE) to the BFF callback');
    mark('oidc-login');

    step = 'session-established';
    const sessionResponse = await context.request.get(`${input.origin}/api/v1/auth/session`, { timeout: 15_000 });
    const session = await sessionResponse.json().catch(() => null);
    if (sessionResponse.status() !== 200) throw new AcceptanceError('session_missing');
    if (!session || session.mode !== 'oidc' || !session.identity) throw new AcceptanceError('session_invalid');
    report.checks.push('Opaque same-origin session established through the real OIDC callback');
    mark('session-established');

    step = 'workbench';
    await shelfOf(page).waitFor();
    mark('workbench');

    step = 'dev-login-disabled';
    await assertDevLoginDisabled(browser, input.origin);
    report.checks.push('Development identity entry is absent in the UI and dev-login returns 404');
    mark('dev-login-disabled');

    step = 'create-work';
    const title = `${ACCEPTANCE_TITLE_PREFIX}${run}`;
    await shelfOf(page).getByRole('button', { name: '新建书本', exact: true }).click();
    const createDialog = page.getByRole('dialog');
    await createDialog.getByLabel('书名', { exact: true }).fill(title);
    await createDialog.getByLabel('简介').fill('生产 OIDC 验收自动创建，请保留供人工核对，勿用于真实创作。');
    const created = await withResponse(page, '/api/v1/works', 'POST', () => createDialog.getByRole('button', { name: '创建并开始写作', exact: true }).click());
    if (created.status !== 201 || typeof created.body?.id !== 'string' || !UUID.test(created.body.id)) {
      throw new AcceptanceError('work_create_failed');
    }
    report.workId = created.body.id;
    report.checks.push('Created the marked acceptance work through the real workbench UI');
    mark('create-work');

    step = 'create-chapter';
    await page.getByRole('button', { name: '章节', exact: true }).click();
    const chapterTitle = `${ACCEPTANCE_CHAPTER_PREFIX}${run}`;
    const chapterInput = await openChapterCreateForm(page);
    await chapterInput.fill(chapterTitle);
    const chapter = await withResponse(
      page,
      `/api/v1/works/${report.workId}/chapters`,
      'POST',
      () => page.getByRole('button', { name: '新建章节', exact: true }).click(),
    );
    if (chapter.status !== 201 || typeof chapter.body?.id !== 'string' || !UUID.test(chapter.body.id)) {
      throw new AcceptanceError('chapter_create_failed');
    }
    report.chapterId = chapter.body.id;
    mark('create-chapter');

    step = 'save-chapter';
    const chapterText = `生产 OIDC 验收章节正文 ${run}。`;
    const editor = page.getByLabel(`章节正文：${chapterTitle}`, { exact: true }).locator('[contenteditable="true"]');
    await editor.waitFor();
    await editor.fill(chapterText);
    const saved = await withResponse(
      page,
      `/api/v1/works/${report.workId}/chapters/${report.chapterId}`,
      'PUT',
      () => page.getByRole('button', { name: '保存', exact: true }).click(),
    );
    if (saved.status !== 200) throw new AcceptanceError('chapter_save_failed');
    report.checks.push('Saved minimal chapter text through the real workbench editor');
    mark('save-chapter');

    step = 'verify-persistence';
    const readBack = await context.request.get(
      `${input.origin}/api/v1/works/${report.workId}/chapters/${report.chapterId}`,
      { timeout: 15_000 },
    );
    const persisted = await readBack.json().catch(() => null);
    if (readBack.status() !== 200 || persisted?.text !== chapterText) throw new AcceptanceError('chapter_not_persisted');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await shelfOf(page).waitFor();
    // 刷新后回到书架（书内选择不持久化），再显式打开验收书；章节列表在左栏 nav 的“章节”具名 region 里。
    await openBook(page, title);
    await page.getByRole('button', { name: '章节', exact: true }).click();
    await page.getByRole('region', { name: '章节', exact: true }).getByRole('button').filter({ hasText: chapterTitle }).first().click();
    const visibleAfterReload = await page.waitForFunction(({ label, expected }) => {
      const node = document.querySelector(`[aria-label="${label}"] [contenteditable="true"]`);
      if (!node) return false;
      const text = node.innerText;
      return text === expected || text.replace(/\n+$/, '') === expected.replace(/\n+$/, '');
    }, { label: `章节正文：${chapterTitle}`, expected: chapterText }, { timeout: 30_000, polling: 250 })
      .then(() => true)
      .catch(() => false);
    if (!visibleAfterReload) throw new AcceptanceError('chapter_not_visible_after_reload');
    report.checks.push('Reload re-established the authenticated session and re-read the stored chapter from the server');
    mark('verify-persistence');

    step = 'session-smoke';
    // 统一创作 Agent 的 UI 只在“发送首条消息”时创建会话，而发送必然触发真实模型回合；
    // 生产验收禁止模型请求，因此会话由同源已认证公开 API 创建（见 createAcceptanceSession）。
    // 之后的选中与撤权仍走真实 UI：历史对话 → 刷新 → “创作 Agent · 1” → 永久结束对话。
    const sessionCreated = await createAcceptanceSession(context, input.origin, report.workId);
    if (sessionCreated.status !== 201 || typeof sessionCreated.body?.id !== 'string' || !UUID.test(sessionCreated.body.id)) {
      throw new AcceptanceError('session_create_failed');
    }
    // 先捕获 created id：**即使后续激活失败**，报告也必须带上这个已创建的真实 id，
    // 便于人工按 id 清理，而不是在失败路径上丢掉证据。
    report.sessionId = sessionCreated.body.id;
    report.sessionCreatedVia = 'same-origin-authenticated-api';
    report.checks.push('Created a durable novel-assistant session through the same-origin authenticated API without sending any model request (the unified-Agent UI creates a session only when a message is sent)');

    // 201 只代表"绑定 + create 命令已入队"（creating）；真正的激活在 cell 回执之后。
    // 撤销一个尚未激活的会话在生产语义里毫无意义，因此这里用**同源已认证**的
    // `GET .../sessions` 有界轮询，确认**刚创建的那一条**达到 active 才允许撤销。
    // 绝不把"列表里有别的 active 会话"当成通过，也绝不在超时后继续撤销。
    const activation = await waitForSessionActivation({
      expectedId: report.sessionId,
      // `maxRedirects: 0`：激活判定必须 fail-closed —— 301/302/303/307/308 一律按
      // "非 200 未确认"继续有界轮询，绝不自动跟随重定向（否则一个把已登录请求重定向
      // 到别处的中间人/反代就能伪造一条 200 的会话列表，且 redirect 目标会带着同源
      // 认证凭据被请求）。503/401 等非 200 同样不会被当成 active。
      fetchList: () => context.request.get(`${input.origin}${sessionsListPath(report.workId)}`, { maxRedirects: 0, timeout: 15_000 }),
      now: () => Date.now(),
      sleep: (ms) => new Promise(resolve => { setTimeout(resolve, ms); }),
    });
    report.sessionActivation = activation;
    report.checks.push('Polled the same-origin authenticated session list until the exact created session reached active (bounded, no model request)');

    // 真实 UI 选中刚创建的会话（历史对话默认收起；列表只展示标题 + 序号 + 时间，不展示 uuid）。
    await selectAcceptanceSession(page);
    report.checks.push('Selected the exact created session from the real conversation-history UI without any model request');
    // 选中的会话里必须没有任何消息：本 runner 全程不发送模型请求。
    if ((await page.locator('[data-testid="chat-log"] .msg').count()) !== 0) {
      throw new AcceptanceError('unexpected_model_activity');
    }

    // “永久结束对话”带 window.confirm：显式接受后仍要 DELETE 204 才算撤销成功。
    page.once('dialog', dialog => dialog.accept());
    const sessionOptions = page.locator('.session-options');
    if (!(await sessionOptions.evaluate(node => node.open))) await sessionOptions.locator('summary').click();
    const revoked = await withResponse(
      page,
      `/api/v1/sessions/${report.sessionId}`,
      'DELETE',
      () => page.getByRole('button', { name: '永久结束对话', exact: true }).click(),
    );
    // 非 204 不是"撤销成功"：必须显式失败，绝不在此后仍然报告 passed=true。
    assertSessionRevoked(revoked);
    report.sessionRevoked = true;
    mark('session-smoke');

    if (screenshotDir) {
      const path = resolve(screenshotDir, `workbench-${run}.png`);
      await page.screenshot({ path, fullPage: true });
      report.screenshots.push(path);
    }

    report.passed = true;
  } catch (error) {
    const redacted = redactError(error);
    report.error = { step, code: redacted.code, message: redacted.message };
    mark(step, 'failed');
  } finally {
    // 改密可能已经成功：失败路径也必须如实保留 attempted/uncertain，绝不谎称未修改。
    syncPasswordReport();
    if (browser) await browser.close().catch(() => undefined);
    if (runDir) {
      await writeFile(resolve(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
    }
  }
  return report;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const report = await main();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

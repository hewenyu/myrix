// Copyright 2026 The Myrix Authors
// SPDX-License-Identifier: Apache-2.0
/**
 * `tests/acceptance/production-browser.mjs` 的**离线纯测试**（node:test）。
 *
 * 这里只验证"不需要真实 Keycloak / 浏览器"的契约与纯函数：
 *   - 缺 `MYRIX_ACCEPTANCE_ALLOW_MUTATION=1` 时必须在启动浏览器之前拒绝；
 *   - HTTP / 带凭据 / 带路径 / 带查询串 / 非规范的 origin 一律拒绝；
 *   - 导入模块**没有运行副作用**（不读环境变量、不启动浏览器、不写文件）；
 *   - 任何拒绝/错误都只回显固定脱敏文本，绝不回显输入口令；
 *   - Keycloak / 截图目录 / 直接执行判定的 URL 契约。
 *
 * 明确**不**声称：真实 Keycloak、真实浏览器、真实镜像的生产 HTTPS 验收已经通过；
 * 那需要在 GitHub Actions 正式镜像发布后由人工在目标主机上运行本 runner 才有结论。
 *
 * 运行：node --test tests/auth-deploy/production-browser.test.mjs
 * （file: 相对路径也在本文件内解析，因此可从仓库任意目录调用。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ACCEPTANCE_CHAPTER_PREFIX,
  ACCEPTANCE_TITLE_PREFIX,
  AcceptanceError,
  ENV,
  applyPasswordChangeProgress,
  assertPasswordUpdatePage,
  assertSessionRevoked,
  createPasswordChangeProgress,
  createPasswordProgressTracker,
  isDirectRun,
  isKeycloakLoginUrl,
  isKeycloakRequiredActionUrl,
  parseAcceptanceOrigin,
  passwordChangeReport,
  redactError,
  resolveScreenshotDir,
  safePathname,
  shouldBlockExternalRequest,
  validateAcceptanceEnv,
} from '../acceptance/production-browser.mjs';

const ORIGIN = 'https://myrix.example.test';
const SECRET = 'super-secret-password-0001';
const MODULE_URL = new URL('../acceptance/production-browser.mjs', import.meta.url);
const SOURCE = readFileSync(MODULE_URL, 'utf8');

/** 一份合法的验收环境；默认带显式 mutation 确认。 */
const baseEnv = (overrides = {}) => ({
  [ENV.allowMutation]: '1',
  [ENV.origin]: ORIGIN,
  [ENV.username]: 'myrix-owner',
  [ENV.password]: SECRET,
  ...overrides,
});

/**
 * 断言某段文本不包含口令本身，也不包含任何**口令特有**的片段。
 * 只排除通用词（如 "password" 会合法地出现在固定文案 MYRIX_ACCEPTANCE_PASSWORD 里），
 * 其余片段一律视为泄露。
 */
const GENERIC = new Set(['password', 'secret']);
const holdsNoSecret = actual => {
  const text = typeof actual === 'string' ? actual : JSON.stringify(actual);
  assert.equal(text.includes(SECRET), false, 'redacted output leaked the password');
  for (const token of SECRET.split('-')) {
    if (GENERIC.has(token)) continue;
    assert.equal(token.length > 3 && text.includes(token), false, `redacted output leaked password fragment ${token}`);
  }
};

/* ------------------------------------------------------------------ */
/* mutation 确认                                                        */
/* ------------------------------------------------------------------ */

test('缺少 MYRIX_ACCEPTANCE_ALLOW_MUTATION=1 时在启动浏览器之前拒绝', () => {
  for (const value of [undefined, '', '0', 'true', 'yes', '2']) {
    assert.throws(
      () => validateAcceptanceEnv(baseEnv({ [ENV.allowMutation]: value })),
      error => error instanceof AcceptanceError && error.code === 'mutation_not_allowed',
    );
  }
  // 只有字面 "1" 通过。
  assert.equal(validateAcceptanceEnv(baseEnv()).origin, ORIGIN);
});

/* ------------------------------------------------------------------ */
/* origin 校验                                                          */
/* ------------------------------------------------------------------ */

test('origin 必须是显式、规范、无路径/凭据/查询的 HTTPS origin', () => {
  assert.equal(parseAcceptanceOrigin(ORIGIN), ORIGIN);
  assert.equal(parseAcceptanceOrigin('https://myrix.example.test:8443'), 'https://myrix.example.test:8443');

  const cases = [
    ['http://myrix.example.test', 'origin_not_https'],
    ['http://127.0.0.1:8787', 'origin_not_https'],
    ['myrix.example.test', 'origin_invalid'],
    ['not a url', 'origin_invalid'],
    ['https://user:pass@myrix.example.test', 'origin_has_credentials'],
    ['https://myrix.example.test/', 'origin_not_canonical'],
    ['https://myrix.example.test/path', 'origin_has_path'],
    ['https://myrix.example.test/api/v1', 'origin_has_path'],
    ['https://myrix.example.test?x=1', 'origin_has_query'],
    ['https://myrix.example.test#frag', 'origin_has_query'],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => parseAcceptanceOrigin(value),
      error => error instanceof AcceptanceError && error.code === code,
      `expected ${value} to be rejected as ${code}`,
    );
  }
  assert.throws(() => parseAcceptanceOrigin(undefined), error => error.code === 'origin_missing');
  assert.throws(() => parseAcceptanceOrigin(''), error => error.code === 'origin_missing');
});

test('缺少用户名/口令时给出固定 code，且不回显口令', () => {
  assert.throws(
    () => validateAcceptanceEnv(baseEnv({ [ENV.username]: undefined })),
    error => error.code === 'username_missing',
  );
  assert.throws(
    () => validateAcceptanceEnv(baseEnv({ [ENV.username]: '' })),
    error => error.code === 'username_missing',
  );
  assert.throws(
    () => validateAcceptanceEnv(baseEnv({ [ENV.password]: undefined })),
    error => error.code === 'password_missing',
  );
  assert.throws(
    () => validateAcceptanceEnv(baseEnv({ [ENV.password]: '' })),
    error => error.code === 'password_missing',
  );
});

test('可选 NEW_PASSWORD：缺失为 null，空串视为未提供', () => {
  assert.equal(validateAcceptanceEnv(baseEnv()).newPassword, null);
  assert.equal(validateAcceptanceEnv(baseEnv({ [ENV.newPassword]: '' })).newPassword, null);
  assert.equal(validateAcceptanceEnv(baseEnv({ [ENV.newPassword]: 'next-password-0002' })).newPassword, 'next-password-0002');
});

/* ------------------------------------------------------------------ */
/* secret 绝不回显                                                      */
/* ------------------------------------------------------------------ */

test('错误信息绝不回显 secret（口令、origin 片段）', () => {
  for (const env of [
    baseEnv({ [ENV.origin]: 'http://127.0.0.1:8787' }),
    baseEnv({ [ENV.origin]: `https://user:${SECRET}@myrix.example.test` }),
    baseEnv({ [ENV.allowMutation]: '0' }),
    baseEnv({ [ENV.password]: '' }),
  ]) {
    try {
      validateAcceptanceEnv(env);
      assert.fail('expected validateAcceptanceEnv to reject');
    } catch (error) {
      holdsNoSecret(error.message);
      holdsNoSecret(redactError(error));
      assert.equal(typeof error.code, 'string');
    }
  }
  // 口令本身永远不出现在任何固定文案里。
  holdsNoSecret(Object.values(redactError(new AcceptanceError('password_missing'))));
});

test('redactError 对未知异常折叠成固定文案，绝不透传 Playwright/网络原文', () => {
  // 模拟 Playwright 风格的 locator 错误：含 URL 与输入值。
  const leaky = new Error(`locator.fill: timeout at ${ORIGIN}/auth/realms/myrix?code=abc&state=def waiting for input[value="${SECRET}"]`);
  leaky.name = 'TimeoutError';
  const redacted = redactError(leaky);
  assert.deepEqual(redacted, {
    code: 'unexpected_error',
    message: '浏览器或平台验收失败；原始错误已按策略脱敏（不含 Playwright/网络细节）',
  });
  holdsNoSecret(redacted);
  assert.equal(JSON.stringify(redacted).includes('code='), false);
  assert.equal(JSON.stringify(redacted).includes('auth/realms'), false);

  // AcceptanceError 只按 code 取固定文案，构造函数无法塞入任意文本。
  const custom = new AcceptanceError('idp_error');
  custom.message = `${SECRET}`;
  assert.equal(redactError(custom).message, 'Keycloak 拒绝了本次登录（用户名/口令或账号状态），原始错误已脱敏');
  holdsNoSecret(redactError(custom));
});

/* ------------------------------------------------------------------ */
/* URL 契约（绝不把查询串带进输出）                                     */
/* ------------------------------------------------------------------ */

test('Keycloak 登录 URL 契约：同源 + realm 路径 + code + S256', () => {
  const good = `${ORIGIN}/auth/realms/myrix/protocol/openid-connect/auth?client_id=myrix-bff&response_type=code&code_challenge_method=S256&state=${SECRET}&code_challenge=xyz`;
  assert.equal(isKeycloakLoginUrl(good, ORIGIN), true);
  // Keycloak 渲染/重定向到登录动作端点时也接受（最终仍以稳定表单字段为准）。
  assert.equal(isKeycloakLoginUrl(`${ORIGIN}/auth/realms/myrix/login-actions/authenticate?session_code=x&execution=y&client_id=myrix-bff`, ORIGIN), true);
  // 缺 PKCE / 换成 implicit / 换 realm / 换源 一律不认。
  assert.equal(isKeycloakLoginUrl(`${ORIGIN}/auth/realms/myrix/protocol/openid-connect/auth?response_type=code`, ORIGIN), false);
  assert.equal(isKeycloakLoginUrl(`${ORIGIN}/auth/realms/myrix/protocol/openid-connect/auth?response_type=token&code_challenge_method=S256`, ORIGIN), false);
  assert.equal(isKeycloakLoginUrl(`${ORIGIN}/auth/realms/master/protocol/openid-connect/auth?response_type=code&code_challenge_method=S256`, ORIGIN), false);
  assert.equal(isKeycloakLoginUrl(`https://evil.example.test/auth/realms/myrix/protocol/openid-connect/auth?response_type=code&code_challenge_method=S256`, ORIGIN), false);
  // 授权端点必须精确匹配 pathname：子路径/后缀（前缀相同）一律不认。
  assert.equal(isKeycloakLoginUrl(`${ORIGIN}/auth/realms/myrix/protocol/openid-connect/auth/extra?response_type=code&code_challenge_method=S256`, ORIGIN), false);
  assert.equal(isKeycloakLoginUrl(`${ORIGIN}/auth/realms/myrix/protocol/openid-connect/auth-x?response_type=code&code_challenge_method=S256`, ORIGIN), false);
  assert.equal(isKeycloakLoginUrl(`${ORIGIN}/auth/realms/myrix/login-actions/authenticate/extra`, ORIGIN), false);
  assert.equal(isKeycloakLoginUrl('not a url', ORIGIN), false);
});

test('required-action URL 契约：只认同机 realm 的精确路径', () => {
  assert.equal(isKeycloakRequiredActionUrl(`${ORIGIN}/auth/realms/myrix/login-actions/required-action?execution=UPDATE_PASSWORD`, ORIGIN), true);
  assert.equal(isKeycloakRequiredActionUrl(`${ORIGIN}/auth/realms/myrix/login-actions/required-action`, ORIGIN), true);
  assert.equal(isKeycloakRequiredActionUrl(`${ORIGIN}/auth/realms/myrix/login-actions/required-action/extra`, ORIGIN), false);
  assert.equal(isKeycloakRequiredActionUrl(`${ORIGIN}/api/v1/auth/callback?code=${SECRET}`, ORIGIN), false);
  assert.equal(isKeycloakRequiredActionUrl('nope', ORIGIN), false);
});

test('safePathname 只返回 pathname，绝不泄露查询串里的 code/state', () => {
  assert.equal(safePathname(`${ORIGIN}/api/v1/auth/callback?code=${SECRET}&state=abc`), '/api/v1/auth/callback');
  assert.equal(safePathname('not a url'), '');
  assert.equal(safePathname(`${ORIGIN}/auth/realms/myrix/login-actions/required-action?execution=UPDATE_PASSWORD&x=${SECRET}`), '/auth/realms/myrix/login-actions/required-action');
});

/* ------------------------------------------------------------------ */
/* 截图目录 / 直接执行判定                                              */
/* ------------------------------------------------------------------ */

test('截图目录必须位于仓库 data/ 之下（gitignore 覆盖），否则拒绝', () => {
  const repo = '/repo';
  assert.equal(resolveScreenshotDir(undefined, repo), null);
  assert.equal(resolveScreenshotDir('', repo), null);
  assert.equal(resolveScreenshotDir('data/acceptance/shot', repo), resolve(repo, 'data/acceptance/shot'));
  assert.equal(resolveScreenshotDir('data', repo), resolve(repo, 'data'));
  for (const bad of ['/tmp/shot', 'tests/acceptance/shot', '../outside', 'data/../tests/shot']) {
    assert.throws(
      () => resolveScreenshotDir(bad, repo),
      error => error instanceof AcceptanceError && error.code === 'screenshot_dir_outside_data',
      `expected ${bad} to be rejected`,
    );
  }
});

test('只有直接 CLI 执行才判定为 main；import 时不启动', () => {
  assert.equal(isDirectRun(MODULE_URL.href, resolve(MODULE_URL.pathname ?? '')), true);
  assert.equal(isDirectRun(MODULE_URL.href, ''), false);
  assert.equal(isDirectRun(MODULE_URL.href, undefined), false);
  assert.equal(isDirectRun(MODULE_URL.href, '/some/other/script.mjs'), false);
  assert.equal(isDirectRun(MODULE_URL.href, 'relative.mjs'), false);
});

/* ------------------------------------------------------------------ */
/* 导入无副作用 + 静态契约                                              */
/* ------------------------------------------------------------------ */

/** 去掉行/块注释后再做静态契约扫描，避免注释文本误伤（注释不影响运行语义）。 */
const codeOnly = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CODE = codeOnly(SOURCE);

test('导入模块不启动浏览器、不读环境变量、不写文件（静态契约）', () => {
  // 模块作用域语句（顶格行，import 声明本身无副作用）：不得出现浏览器/文件系统调用。
  const topLevel = CODE.split('\n').filter(line => line.length > 0 && !/^\s/.test(line) && !/^import\b/.test(line));
  const offenders = topLevel.filter(line => /playwright|writeFile|mkdir|\.launch\(|\.goto\(/.test(line));
  assert.deepEqual(offenders, [], 'module scope must not perform browser or filesystem work');
  // process.env 只允许作为 main 的默认参数出现，绝不在 import 求值时读取。
  assert.deepEqual(
    topLevel.filter(line => /process\.env/.test(line)),
    ['export async function main(env = process.env) {'],
  );
  // 唯一的 main() 调用点必须在 isDirectRun 守卫里。
  const guarded = /if \(isDirectRun\(import\.meta\.url, process\.argv\[1\]\)\) \{[\s\S]*?await main\(\)[\s\S]*?\}/;
  assert.match(CODE, guarded);
  const outsideGuard = CODE.replace(guarded, '').replace(/export async function main\s*\(/, 'function ');
  assert.equal(/\bmain\s*\(/.test(outsideGuard), false, 'main() must only run behind the isDirectRun guard');
  // 浏览器启动参数里不得出现 trace/video/storageState/录制能力。
  assert.equal(/recordVideo|recordHar|storageState/.test(CODE), false);
  assert.equal(/\btrace\s*:/.test(CODE), false);
  // 不得启用 console/network 日志监听。
  assert.equal(/page\.on\(['"]console['"]/.test(CODE), false);
  assert.equal(/page\.on\(['"]request['"]/.test(CODE), false);
  // 不得出现绕过认证的路径。
  assert.equal(/directAccessGrant|direct-access|admin\/realms|grant_type=password/i.test(CODE), false);
  assert.equal(/addInitScript|setExtraHTTPHeaders\(.*Cookie/i.test(CODE), false);
});

test('验收前缀固定且显式，便于人工识别与清理', () => {
  assert.equal(ACCEPTANCE_TITLE_PREFIX, 'MYRIX-ACCEPTANCE-');
  assert.equal(ACCEPTANCE_CHAPTER_PREFIX, 'MYRIX-ACCEPTANCE-CH-');
  assert.match(SOURCE, /ACCEPTANCE_TITLE_PREFIX/);
});

test('环境变量名是明确的 MYRIX_ACCEPTANCE_* 集合', () => {
  assert.deepEqual(Object.values(ENV).sort(), [
    'MYRIX_ACCEPTANCE_ALLOW_MUTATION',
    'MYRIX_ACCEPTANCE_NEW_PASSWORD',
    'MYRIX_ACCEPTANCE_ORIGIN',
    'MYRIX_ACCEPTANCE_PASSWORD',
    'MYRIX_ACCEPTANCE_SCREENSHOT_DIR',
    'MYRIX_ACCEPTANCE_USERNAME',
  ]);
});

test('直接执行时以退出码表达结果，且报告只含脱敏字段', () => {
  assert.match(CODE, /process\.exitCode = report\.passed \? 0 : 1/);
  assert.match(CODE, /report\.error = \{ step, code: redacted\.code, message: redacted\.message \}/);
  // 绝不持久化 browser storageState。
  assert.equal(/storageState/.test(CODE), false);
});

/* ------------------------------------------------------------------ */
/* 外部 origin 锁                                                       */
/* ------------------------------------------------------------------ */

test('精确 origin 锁：同源放行、外部 http(s) 一律判定为应中止', () => {
  assert.equal(shouldBlockExternalRequest(`${ORIGIN}/api/v1/auth/session`, ORIGIN), false);
  assert.equal(shouldBlockExternalRequest(`${ORIGIN}/auth/realms/myrix/login-actions/authenticate?x=1`, ORIGIN), false);
  assert.equal(shouldBlockExternalRequest('https://evil.example.test/collect', ORIGIN), true);
  assert.equal(shouldBlockExternalRequest('https://evil.example.test', ORIGIN), true);
  assert.equal(shouldBlockExternalRequest('http://myrix.example.test/x', ORIGIN), true);
  // 非网络协议不属于本锁范围。
  assert.equal(shouldBlockExternalRequest('about:blank', ORIGIN), false);
  assert.equal(shouldBlockExternalRequest('data:text/html,hi', ORIGIN), false);
  assert.equal(shouldBlockExternalRequest('not a url', ORIGIN), false);
});

test('外部跳转错误是固定脱敏 code，绝不回显目标 URL', () => {
  const redacted = redactError(new AcceptanceError('external_navigation_blocked'));
  assert.equal(redacted.code, 'external_navigation_blocked');
  assert.equal(typeof redacted.message, 'string');
  assert.equal(redacted.message.includes('evil.example.test'), false);
  // 静态契约：请求锁存在，且不把原始 URL 写进任何输出。
  assert.match(CODE, /context\.route\(/);
  assert.equal(/console\.(log|error)\([^)]*route\.request\(\)\.url/.test(CODE), false);
});

/* ------------------------------------------------------------------ */
/* 改密进度状态机                                                       */
/* ------------------------------------------------------------------ */

test('填写新口令前必须严格校验同源 + 精确 required-action 路径', () => {
  // 合法：同源精确路径，带 / 不带查询串都通过。
  assert.equal(assertPasswordUpdatePage(`${ORIGIN}/auth/realms/myrix/login-actions/required-action`, ORIGIN), true);
  assert.equal(assertPasswordUpdatePage(`${ORIGIN}/auth/realms/myrix/login-actions/required-action?execution=UPDATE_PASSWORD`, ORIGIN), true);

  // 非法：外部源、前缀/后缀路径、回调页，全部固定 code 拒绝且不回显 URL。
  const bad = [
    `https://evil.example.test/auth/realms/myrix/login-actions/required-action`,
    `${ORIGIN}/auth/realms/myrix/login-actions/required-action/extra`,
    `${ORIGIN}/auth/realms/myrix/login-actions/required-action-x`,
    `${ORIGIN}/api/v1/auth/callback?code=${SECRET}`,
    'not a url',
  ];
  for (const url of bad) {
    assert.throws(
      () => assertPasswordUpdatePage(url, ORIGIN),
      error => error instanceof AcceptanceError && error.code === 'idp_unexpected_required_action',
      `expected ${url} to be rejected`,
    );
  }
});

test('改密进度：提交前即登记不确定，确认后才落定', () => {
  // 初始：未尝试、不确定为 false、passwordChanged=false。
  assert.deepEqual(passwordChangeReport(createPasswordChangeProgress()), {
    passwordChanged: false,
    passwordChangeAttempted: false,
    passwordChangeUncertain: false,
  });

  // 成功路径：submitting → confirmed。
  let tracker = createPasswordProgressTracker();
  tracker.record('submitting');
  assert.deepEqual(passwordChangeReport(tracker.state), {
    passwordChanged: false,
    passwordChangeAttempted: true,
    passwordChangeUncertain: true,
  });
  tracker.record('confirmed');
  assert.deepEqual(passwordChangeReport(tracker.state), {
    passwordChanged: true,
    passwordChangeAttempted: true,
    passwordChangeUncertain: false,
  });

  // 改密后 profile-update 要求人工：已确认状态必须保留。
  tracker = createPasswordProgressTracker();
  tracker.record('submitting');
  tracker.record('confirmed');
  assert.equal(passwordChangeReport(tracker.state).passwordChanged, true);
  assert.equal(passwordChangeReport(tracker.state).passwordChangeUncertain, false);

  // 提交后网络/callback 失败：保留 uncertain，绝不谎称未修改。
  tracker = createPasswordProgressTracker();
  tracker.record('submitting');
  tracker.record('uncertain');
  assert.deepEqual(passwordChangeReport(tracker.state), {
    passwordChanged: false,
    passwordChangeAttempted: true,
    passwordChangeUncertain: true,
  });

  // 明确拒绝的旧改密页 → 未确认，仍报 uncertain（宁可保守）。
  tracker = createPasswordProgressTracker();
  tracker.record('submitting');
  tracker.record('rejected');
  assert.equal(passwordChangeReport(tracker.state).passwordChangeUncertain, true);
  assert.equal(passwordChangeReport(tracker.state).passwordChanged, false);

  // 未提交前的输入错误：既不 attempted 也不 uncertain。
  tracker = createPasswordProgressTracker();
  tracker.record('uncertain');
  assert.deepEqual(passwordChangeReport(tracker.state), {
    passwordChanged: false,
    passwordChangeAttempted: false,
    passwordChangeUncertain: false,
  });

  // 纯函数：confirmed 只在 attempted 之后生效。
  assert.deepEqual(applyPasswordChangeProgress(createPasswordChangeProgress(), 'confirmed'), createPasswordChangeProgress());
});

test('改密成功后即使抛错，报告仍保留 passwordChanged（finally 同步）', () => {
  // 报告字段由纯函数折叠；静态契约保证 finally 里也同步一次。
  assert.match(CODE, /syncPasswordReport\(\);/);
  assert.match(CODE, /passwordChangeAttempted/);
  assert.match(CODE, /passwordChangeUncertain/);
  // 新口令绝不写盘/进报告：报告里不出现 newPassword 字段。
  assert.equal(/report\.\w*[Nn]ewPassword/.test(CODE), false);
  assert.equal(/JSON\.stringify\(report[\s\S]*?newPassword/.test(CODE), false);
});

/* ------------------------------------------------------------------ */
/* 会话撤销失败绝不放行                                                 */
/* ------------------------------------------------------------------ */

test('撤销会话只有 204 才算成功；非 204 抛固定脱敏 code', () => {
  // 只有 204 通过。
  assert.equal(assertSessionRevoked({ status: 204, body: null }), true);

  // 其余状态（含 2xx 的非 204、4xx/5xx、缺失响应）一律固定 code 拒绝。
  for (const response of [
    { status: 200 },
    { status: 202 },
    { status: 204.5 },
    { status: 400 },
    { status: 401 },
    { status: 403 },
    { status: 404 },
    { status: 500 },
    { status: 0 },
    { status: null },
    { status: undefined },
    { status: '204' },
    {},
    null,
  ]) {
    assert.throws(
      () => assertSessionRevoked(response),
      error => error instanceof AcceptanceError && error.code === 'session_revoke_failed',
      `expected status ${JSON.stringify(response)} to fail revocation`,
    );
  }

  // 固定脱敏：code 可被 redactError 映射，且不含任何响应原文/URL。
  const redacted = redactError(new AcceptanceError('session_revoke_failed'));
  assert.equal(redacted.code, 'session_revoke_failed');
  assert.equal(typeof redacted.message, 'string');
  holdsNoSecret(redacted);
});

test('主流程在标记 passed 之前必须先通过 session_revoke_failed 校验（静态契约）', () => {
  const call = CODE.indexOf('assertSessionRevoked(revoked);');
  const revokeFlag = CODE.indexOf('report.sessionRevoked = true;');
  const passed = CODE.indexOf('report.passed = true;');
  assert.notEqual(call, -1, 'main must call assertSessionRevoked(revoked)');
  assert.notEqual(revokeFlag, -1, 'main must set report.sessionRevoked = true only after the assertion');
  assert.notEqual(passed, -1);
  assert.ok(call < revokeFlag, 'revoked flag must be set only after the assertion passes');
  assert.ok(revokeFlag < passed, 'passed=true must come after the revocation check');
  // 绝不再保留"用状态比较直接赋值、失败也继续"的旧写法。
  assert.equal(/report\.sessionRevoked\s*=\s*revoked\.status\s*===/.test(CODE), false);
});

/* ------------------------------------------------------------------ */
/* 不改不测说明                                                        */
/* ------------------------------------------------------------------ */

test('离线测试不声称真实 Keycloak/浏览器/生产镜像验收已通过', () => {
  // 这里只覆盖纯契约；真实登录需人工在目标主机运行 runner。
  assert.equal(/playwright/.test(CODE), true, '模块只在 main 内部动态 import playwright');
  assert.equal(/\bfrom ['"]playwright['"]/.test(CODE), false);
});

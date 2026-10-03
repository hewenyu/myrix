# 项目 skills

Myrix 将稳定的业务与开发方法作为开发者 Harness skills 分发；它们不是小说助手的运行插件，不进入 Cell。

| Skill | 用途 | 分发 |
| --- | --- | --- |
| [myrix-business](<../../.agents/skills/myrix-business/SKILL.md>) | 对象、权限、用户流程、需求影响与验收 | Git 跟踪 |
| [myrix-development](<../../.agents/skills/myrix-development/SKILL.md>) | 模块定位、实现、安全回归、质量门禁和文档同步 | Git 跟踪 |
| [myrix-ui-design](<../../.agents/skills/myrix-ui-design/SKILL.md>) | 作者优先的 UX、信息分层、文本保真与安全 Markdown、设计令牌、响应式/专注模式、CAS 草稿安全与浏览器证据 | Git 跟踪 |
| `myrix-deploy` | 维护者目标确认、发布、认证、备份与恢复 | 仅本地；Git/Docker 忽略，不随 clone 分发 |

三个开发者 skill 的 frontmatter 与协议/Cell 边界由 [skills 回归](<../../tests/ci/skills.test.mjs>) 覆盖；UI 规范的权威文档是 [工作台 UI 设计标准](<ui-design.md>)。

## 发现与格式

上游当前实现以最近包含 `.git` 的祖先作为 project root。按优先级读取项目 `.dsh/skills`、项目 `.agents/skills`、配置的自定义路径、用户 `.dsh/skills`、用户 `.agents/skills`、内置目录；同名冲突按优先级处理。

每个搜索目录支持 `<name>/SKILL.md` 或平铺 `<name>.md`，不是任意深度递归。文件必须带 YAML frontmatter，包含小写 kebab-case `name` 和非空 `description`；可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。不要使用旧 camelCase 的 invocation 字段，否则整个 skill 可能被警告并丢弃。

```yaml
---
name: myrix-example
description: 描述任务、适用场景与边界。
---
```

需要支持 skills 的开发者 Harness 重新扫描或重新打开项目后确认目录。**创建文件不证明当前会话已经加载**；最终以当前会话的 skill catalog 为准。维护者部署 skill 设为禁止模型自动调用，需手动选择。

## 安全边界

- 当前 Myrix Cell 不装配 skill 插件或 `skill` 工具，不为这些文档扩大白名单。
- skill 是操作指引，不代替源码契约、授权、测试或人的部署权限。
- skill 文档路径按文件位置解析；流程命令以仓库根目录执行。
- 公共部署说明始终放在[自部署指南](<../deployment/self-hosting.md>)，不得依赖仅维护者可见的现场记录。
- 维护文档遵循[文档政策](<../documentation-policy.md>)，不存 API key、Cookie、私钥或生产连接串。

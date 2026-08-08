# Arcana Screenpipe 集成 — 增补说明

本文档补充说明在原 Arcana 基础上新增的 Screenpipe 屏幕感知集成功能。

## 新增功能

### 屏幕自动感知
每次用户发消息前，Arcana 自动查询 screenpipe 获取屏幕 OCR 文字，注入到对话上下文。
Agent 天然"带视力"——不需要手动调用工具就能知道用户在做什么。

### 主动错误检测
Proactive Orchestrator 每 30 秒检查屏幕内容，检测到报错（TypeError、npm ERR 等）自动推送修复建议。
相同错误 5 分钟内不重复报警。

### 安全合规系统
- **RULES.md**：铁律规则，写入 System Prompt，AI 必须百分百遵守
- **原则面板**：网页端设置全局原则 + 当前对话原则
- **审批弹窗**：高危操作两步确认，先看规则再决定
- **Guardrails**：入口检查（高风险命令拦截）+ 出口检查（敏感信息防泄露）
- **工作区锁**：所有 write/edit 限于工作区目录

### 文件操作增强
- 解锁了 `write` / `edit` 工具（原版 Arcana 默认禁用）
- 带 `ensureWriteAllowed` 工作区路径保护
- 受保护文件修改需审批弹窗确认

## 新增文件

| 文件 | 作用 |
|------|------|
| `src/screenpipe-inject.js` | 屏幕 OCR 自动注入引擎 |
| `src/guardrails.js` | 上下文感知安全拦截 |
| `src/approval-manager.js` | 审批弹窗请求/响应管理 |
| `src/principles.js` | 原则存储与 System Prompt 注入 |
| `plugins/screenpipe.js` | Screenpipe 插件（3 个屏幕工具） |
| `sidecars/proactive-orchestrator/` | 主动错误检测引擎 |
| `sidecars/screenpipe-mcp-bridge/` | MCP 协议桥（备用） |
| `scripts/setup.mjs` | 交互式初始化向导 |
| `scripts/start.mjs` | 一键启动脚本 |
| `setup.bat` / `start.bat` | Windows 图形用户双击启动 |

## 安装与使用

### 一键安装

```bash
npm install      # 自动安装 screenpipe + 所有依赖
npm run setup    # 交互式初始化（填 API Key、选模型）
npm start        # 一键启动 screenpipe + gateway + orchestrator
```

或双击 `setup.bat` → 填配置 → 双击 `start.bat`。

### 首次使用

1. 打开 `http://127.0.0.1:8787`
2. 面板右侧可看到"原则"、"工具" 等标签
3. 在"原则"面板设置全局/对话原则
4. 发送消息时 Agent 自动感知屏幕内容

### 配置原则

- **全局原则**：对所有会话生效
- **对话原则**：仅对当前会话生效
- 支持 Markdown / 纯文本 / 文件上传（.txt, .md）
- 设置后创建新会话，首条消息弹出原则确认窗口

## 架构变更

```
原 Arcana:
  Gateway → Agent → (read/grep/find/ls only)

现 Arcana + Screenpipe:
  screenpipe (:3030) ──→ 屏幕 OCR 自动注入 ──→ Gateway (:8787)
       │                        │
       │                        ├── 入口检查 (guardrails + principle conflicts)
       │                        ├── Agent (write/edit enabled, workspace-locked)
       │                        ├── 审批弹窗 (approval-manager)
       │                        └── 出口检查 (sensitive info scan)
       │
       └── Proactive Orchestrator ──→ 错误检测 ──→ 自动推送建议
```

## 模型建议

当前默认使用 DeepSeek-Reasoner（openai-compatible 模式），适合功能验证。
正式使用建议：
- 保险等合规场景：使用可私有化部署的模型（Qwen、Llama 等）
- 一般开发场景：DeepSeek、Claude、GPT 均可
- 可通过 `arcana-home/config.json` 切换模型

## 更多

- 主 README：[README.md](README.md)
- 项目主页：[https://github.com/mrpanfish66-cpu/arcana](https://github.com/mrpanfish66-cpu/arcana)
- Screenpipe：[https://screenpi.pe](https://screenpi.pe)

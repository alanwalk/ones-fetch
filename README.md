# ONES 子任务采集工具

一个本地 Web 工具，用浏览器界面批量解析 ONES 任务链接或任务编号，并递归抓取所有子任务。

## 环境要求

- Node.js 18+
- 可访问的 ONES 租户 URL
- `npm install`（会安装 Playwright）

## 安装

```bash
npm install
```

---

## 快速开始

### 1. 启动 Web 服务

```bash
npm run dev
```

启动后访问 `http://localhost:3000`。

### 2. 粘贴 ONES 任务文本

- 支持粘贴完整 ONES 任务链接
- 也支持直接粘贴 `#90182|#90183` 这种编号文本
- 页面会自动提取任务编号并递归抓取所有子任务

### 3. 首次使用时连接 ONES

- 如果本地还没有有效凭据，页面会提示“连接 ONES”
- 点击后会打开浏览器登录页
- 登录完成后页面会自动重试解析

---

## CLI（可选）

### `login`

交互式登录并持久化凭证。

```bash
node src/ones-subtasks-cli.mjs login [--base-url <url>] [--verbose]
```

- 启动无头 Playwright 浏览器，自动填写 LDAP 凭证并从 `/sso/login` 响应中捕获认证令牌。
- 如果无头模式无法捕获令牌，自动降级到有头（可见）浏览器，允许手动完成登录。
- 将 `{ authToken, userId, baseUrl }` 保存到 `~/.ones-fetch/credentials.json`（权限 600）。
- 当令牌过期（请求返回 401）时，CLI 会提示重新运行 `login`。

**自定义选择器**（适用于非标准登录页面）：

```bash
node src/ones-subtasks-cli.mjs login --login-username-selector '#custom-user-input' --login-password-selector '#custom-pass-input'
```

### `config`

管理持久化配置，存储在 `~/.ones-fetch/config.json`。

```bash
# 设置值
node src/ones-subtasks-cli.mjs config set base-url https://your-team.ones.cn
node src/ones-subtasks-cli.mjs config set team-id <team-uuid>

# 查看所有配置
node src/ones-subtasks-cli.mjs config get
node src/ones-subtasks-cli.mjs config list

# 查看单个配置值
node src/ones-subtasks-cli.mjs config get base-url
```

支持的键：`base-url`、`team-id`。

---

## 采集选项

```
必填（或通过 config / 环境变量）：
  --base-url <url>       ONES 基础 URL
  --team-id <id>         团队 UUID（可在任意 API URL 的 /team/ 后找到）
  --task-id <id>[,...]   任务 UUID 或编号；逗号分隔多个值

可选：
  --max-depth <n>        最大递归深度（默认 10）
  --format <json|csv>    输出格式（默认 json）
  --output <path>        写入文件而非标准输出
  --headed               显示浏览器窗口（调试登录用）
  --verbose              打印进度到标准错误
  --username <user>      覆盖已保存的凭证（向后兼容）
  --password <pass>      覆盖已保存的凭证（向后兼容）
  --help                 显示帮助
```

### 参数优先级

CLI 参数 > 环境变量 > config 文件（`~/.ones-fetch/config.json`）

### 多任务输出

当 `--task-id` 包含多个值时，结果按 UUID 去重，JSON 输出结构变化：

```json
{
  "roots": ["<uuid1>", "<uuid2>"],
  "tasks": [
    { "uuid": "...", "root_uuid": "<uuid1>", ... },
    ...
  ]
}
```

单根任务时保持平铺数组格式。CSV 输出会增加 `root_uuid` 列。

---

## Web API

启动 `src/server.mjs` 后提供以下接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | Web UI 首页 |
| `GET` | `/api/auth/status` | 当前认证状态 |
| `POST` | `/api/auth/login` | 启动浏览器登录采集 |
| `POST` | `/api/crawl` | 批量采集接口 |

**`/api/crawl` 请求格式：**

```json
{
  "taskIds": ["90182", "90183", "HM6gttraKPOVnrdy"],
  "baseUrl": "https://your-team.ones.cn",
  "teamId": "<team-uuid>"
}
```

**响应格式：**

```json
{
  "roots": ["<uuid1>", "<uuid2>"],
  "tasks": [
    { "uuid": "...", "root_uuid": "<uuid1>", "number": "...", "summary": "...", ... },
    ...
  ]
}
```

错误时返回 `401`（需要登录或令牌过期）或 `500`（采集失败）。

---

## 环境变量

所有 CLI 参数都有对应的环境变量：

| 变量 | 对应参数 |
|---|---|
| `ONES_BASE_URL` | `--base-url` |
| `ONES_TEAM_ID` | `--team-id` |
| `ONES_TASK_ID` | `--task-id` |
| `ONES_USERNAME` | `--username` |
| `ONES_PASSWORD` | `--password` |

---

## 本地凭证与配置文件

| 路径 | 用途 |
|---|---|
| `~/.ones-fetch/credentials.json` | `login` 保存的认证令牌（权限 600） |
| `~/.ones-fetch/config.json` | `config set` 保存的持久化配置 |

---

## 辅助工具

### `explore.mjs` — 网络请求捕获

用于分析 ONES 页面的 API 调用。启动有头浏览器，手动操作后保存所有 API 请求/响应到 JSON 文件。

```bash
node src/explore.mjs [--base-url <url>] [--out <file>]
```

# ONES 子任务采集工具

一个本地 Web 工具，用浏览器界面批量解析 ONES 任务链接或任务编号，并递归抓取所有子任务。

## 快速安装（推荐）

策划电脑上已有 Node.js，执行一条命令即可：

```bash
npx ones-fetch
```

这会自动：
- 安装依赖（约 30MB，仅首次需要）
- 在桌面创建快捷方式
- 完成后双击桌面图标即可使用

**注意**：
- 依赖只需安装一次，后续启动无需重新安装
- 服务器会在浏览器关闭 5 分钟后自动退出
- 快捷方式使用 Windows 脚本宿主的默认图标

---

## 环境要求

- Node.js 18+
- Chrome 或 Edge 浏览器（系统已安装）
- 可访问的 ONES 租户 URL

## 手动安装

```bash
git clone <repo-url>
cd ones-fetch
npm install
```

---

## 使用方法

### 方式 1：双击启动（推荐给非技术用户）

**Windows 用户：**
- 双击 `启动 ONES 采集工具.vbs`
- 首次运行会自动安装依赖
- 浏览器会自动打开工具页面

### 方式 2：命令行启动

```bash
npm start
# 或开发模式（自动重启）
npm run dev
```

启动后会自动打开浏览器访问 `http://localhost:3000`。

### 使用流程

1. **首次使用 - 连接 ONES**
   - 页面会提示"连接 ONES"
   - 点击后会打开浏览器登录页
   - 登录完成后，系统会自动捕获认证信息和 team-id

2. **粘贴任务文本**
   - 支持粘贴完整 ONES 任务链接
   - 也支持直接粘贴 `#90182|#90183` 这种编号文本
   - 页面会自动提取任务编号并递归抓取所有子任务

3. **查看结果**
   - 任务列表会显示所有子任务
   - 包含任务编号、标题、状态、负责人、截止日期等信息

---

## 技术说明

### 认证机制

- 首次登录时，系统会启动浏览器窗口
- 自动从页面 URL 提取 team-id（格式：`/team/{uuid}/...`）
- 认证信息保存在 `~/.ones-fetch/credentials.json`（权限 600）
- 令牌过期时会提示重新登录

### Web API

服务提供以下接口：

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

可选的环境变量：

| 变量 | 说明 |
|---|---|
| `PORT` | 服务端口（默认 3000） |
| `ONES_BASE_URL` | ONES 基础 URL |
| `ONES_TEAM_ID` | 团队 UUID（通常自动检测） |

---

## 本地凭证文件

| 路径 | 用途 |
|---|---|
| `~/.ones-fetch/credentials.json` | 登录时保存的认证令牌（权限 600） |

---

## 项目结构

```
ones-fetch/
├── src/
│   ├── server.mjs      # HTTP 服务器和任务爬取逻辑
│   └── auth.mjs        # 浏览器登录和凭证管理
├── public/
│   └── index.html      # Web UI 界面
└── package.json
```

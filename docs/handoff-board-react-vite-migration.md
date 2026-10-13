# Handoff Board: React/Vite 迁移方案

## 1. 目标与约束

### 目标
- 将当前服务端 HTML 字符串拼接渲染迁移为 React + Vite 前端应用
- 保留现有全部 API 端点和 SSE 行为不变
- 实现增量 DOM 更新替代全页刷新
- 改善开发体验（HMR、组件化、TypeScript 类型安全）
- 为 Phase B/C 路线图功能提供可扩展的 UI 基座

### 约束
- **零运行时 npm 依赖**的现有后端保持不变，仅剥离 HTML 渲染职责
- 所有 `/api/*` 端点和 `GET /events` SSE 契约不变
- 迁移完成后移除旧的服务端渲染路径（board.mjs 已删除）
- 最终产物仍为单进程本地运行，无需独立前端部署服务器

---

## 2. 架构变更总览

### Before（当前）

```
Browser ──GET /──► server.mjs ──► board.mjs (HTML string) ──► HTTP Response
                  server.mjs ──► HandoffStore / TraceStoreView / AgentEventsStore
                  SSE: EventSource(/events) → 全页 reload
```

### After（迁移后）

```
Browser ──GET /──► Vite dev: index.html → React App
                  Production: server.mjs serves static build → React App

React App ──fetch /api/*──► server.mjs (pure API) ──► Stores
           ──EventSource(/events)──► 增量状态更新 (SWR/React Query)
```

### 职责划分

| 层 | 迁移前 | 迁移后 |
|----|--------|--------|
| **路由** | server.mjs 内 if/else | React Router (client-side) |
| **数据获取** | server.mjs → store → model → template | React Query / SWR → `/api/*` |
| **HTML 渲染** | board.mjs 字符串拼接 | React 组件树 |
| **CSS** | 内联 `<style>` 重复 3 份 | CSS Modules / Tailwind 单份 |
| **客户端 JS** | 单个 `<script>` 块 | React 组件内 hooks |
| **实时更新** | SSE → `location.reload()` | SSE → React Query invalidation → 增量 DOM |
| **Flash 消息** | 服务端 flash store + redirect | React state / toast |
| **server.mjs** | API + HTML + SSE | **仅 API + SSE + static serve** |

---

## 3. 目录结构

```
board/
├── package.json              # 新增 react/react-dom/vite 等依赖
├── vite.config.mjs           # Vite 配置
├── index.html                # Vite 入口
├── src/
│   ├── server.mjs            # 精简：移除 board.mjs 引用，仅保留 API + SSE + static serve
│   ├── handoff-store.mjs     # 不变
│   ├── state.mjs             # 不变
│   ├── trace-store-view.mjs  # 不变
│   └── client/               # 新增前端应用
│       ├── main.tsx           # React 入口
│       ├── App.tsx            # 根组件 + Router
│       ├── api/               # API 客户端层
│       │   ├── client.ts      # fetch 封装 + 类型定义
│       │   └── sse.ts         # EventSource hook
│       ├── hooks/             # 自定义 hooks
│       │   ├── useTopics.ts
│       │   ├── useAgents.ts
│       │   ├── useTopicDetail.ts
│       │   ├── useAgentDetail.ts
│       │   ├── useOverview.ts
│       │   ├── useOps.ts
│       │   └── useSSE.ts
│       ├── components/        # UI 组件
│       │   ├── layout/
│       │   │   ├── Shell.tsx          # 外壳：sidebar + main
│       │   │   ├── Sidebar.tsx        # 侧栏导航
│       │   │   └── PageContainer.tsx
│       │   ├── topics/
│       │   │   ├── TopicsView.tsx     # Topics 表格
│       │   │   ├── TopicRow.tsx
│       │   │   └── TopicSortHeader.tsx
│       │   ├── agents/
│       │   │   ├── AgentsView.tsx     # Agent 卡片网格
│       │   │   └── AgentCard.tsx
│       │   ├── topic-detail/
│       │   │   ├── TopicDetailPage.tsx
│       │   │   ├── LatestConclusion.tsx
│       │   │   ├── MergedTimeline.tsx
│       │   │   └── TimelineItem.tsx
│       │   ├── agent-detail/
│       │   │   ├── AgentDetailPage.tsx
│       │   │   ├── AgentTopicsList.tsx
│       │   │   └── AgentEventsList.tsx
│       │   ├── ops/
│       │   │   ├── OpsView.tsx
│       │   │   ├── BackupForm.tsx
│       │   │   ├── CleanupForm.tsx
│       │   │   ├── PublishEventForm.tsx
│       │   │   └── HealthPanel.tsx
│       │   ├── overview/
│       │   │   └── OverviewCards.tsx
│       │   └── shared/
│       │       ├── Badge.tsx          # 状态/状态徽章
│       │       ├── Pagination.tsx
│       │       ├── CopyButton.tsx
│       │       ├── Toast.tsx
│       │       └── FilterBar.tsx
│       ├── styles/
│       │   ├── variables.css          # CSS 变量（从 board.mjs 提取）
│       │   ├── global.css             # 重置 + 基础样式
│       │   └── components.css.module  # 组件级 CSS Modules（可选）
│       └── lib/
│           ├── format.ts             # formatLocal / resolveTimeZone
│           └── constants.ts
├── test/
│   ├── state.test.mjs        # 不变
│   └── client/               # 新增前端测试
│       └── ...
└── dist/                     # Vite 构建产物（gitignore）
```

---

## 4. API 契约（现有端点，不变）

迁移后前端消费的 API 端点，全部保持现有行为：

### 数据端点

| 端点 | 方法 | 当前返回 | 迁移后返回 |
|------|------|----------|------------|
| `/api/overview` | GET | `{ activeTopics, blockedSuspectTopics, staleTopics, expiredTopics, agentsActiveRecently, agentsWithRecentErrors }` | 不变 |
| `/api/topics` | GET | `TopicView[]`（含 `state`, `latestUpdatedAtDisplay` 等装饰字段） | 不变 |
| `/api/agents` | GET | `AgentView[]`（含 `state`, `lastSeenAt` 等） | 不变 |
| `/api/topic/{project}/{workspace}/{topic}` | GET | Topic detail JSON | 不变 |
| `/api/agent/{agentName}` | GET | Agent detail JSON | 不变 |
| `/api/ops/health` | GET | Health JSON | 不变 |
| `/api/events` | GET | AgentEvent[]（支持过滤参数） | 不变 |

### 操作端点

| 端点 | 方法 | 当前行为 | 迁移后行为 |
|------|------|----------|------------|
| `/ops/backup` | POST | 303 redirect + flash | 返回 JSON `{ ok, backupDir }` |
| `/ops/cleanup-preview` | POST | 303 redirect + flash | 返回 JSON `{ matchedCount, candidates }` |
| `/ops/publish-event` | POST | 303 redirect + flash | 返回 JSON `{ ok, eventId }` |

**变更点**：三个 POST 端点从 redirect+flash 改为返回 JSON，因为前端用 fetch 调用后可直接处理响应，不再需要服务端 flash 机制。

### SSE 端点

| 端点 | 方法 | 行为 |
|------|------|------|
| `/events` | GET | `text/event-stream`，事件类型：`ready`、`ping`、`update` | 不变 |

---

## 5. 组件拆分映射

### 当前 board.mjs 函数 → React 组件

| board.mjs 函数 | React 组件 | 说明 |
|----------------|------------|------|
| `renderApp(model)` | `<App>` + `<Shell>` + `<Router>` | 路由切换替代 view 参数 |
| `renderOverviewCards(model)` | `<OverviewCards>` | 6 张卡片 |
| `renderTopicsView(model)` | `<TopicsView>` | 表格 + 排序 + 分页 |
| `renderAgentsView(model)` | `<AgentsView>` | 卡片网格 |
| `renderOpsView(model)` | `<OpsView>` | 三个表单 + health |
| `renderTopicPage(model)` | `<TopicDetailPage>` | 详情 + 时间线 |
| `renderAgentPage(model)` | `<AgentDetailPage>` | 详情 + events |
| `renderPagination(model)` | `<Pagination>` | 通用分页组件 |
| `renderSortLink(...)` | `<SortHeader>` | 可排序表头 |
| `renderStateBadge(value)` | `<StateBadge>` | 状态徽章 |
| `renderStatusBadge(value)` | `<StatusBadge>` | handoff 状态徽章 |
| `renderRefreshScript()` | 拆分为 hooks | `useSSE`、`useClipboard`、`useLocalStorage` |

### 页面路由映射

| 当前 URL | React Router 路径 | 组件 |
|----------|-------------------|------|
| `/?view=topics` | `/` 或 `/topics` | `<TopicsView>` |
| `/?view=agents` | `/agents` | `<AgentsView>` |
| `/?view=ops` | `/ops` | `<OpsView>` |
| `/topic/{p}/{w}/{t}` | `/topic/:key`（key = `project::workspace::topic` URL-encoded） | `<TopicDetailPage>` |
| `/agent/{name}` | `/agent/:agentName` | `<AgentDetailPage>` |

---

## 6. 状态管理策略

### 选择：React Query (TanStack Query) v5

理由：
- 天然适配 REST API 数据获取场景
- 内置缓存、去重、后台刷新、stale-while-revalidate
- SSE `update` 事件触发 `invalidateQueries` 即可实现增量更新
- 无需额外全局状态库（Redux/Zustand），API 数据由 React Query 管理，UI 状态由组件 local state 管理

### 数据流

```
SSE "update" event
  → queryClient.invalidateQueries({ queryKey: ['topics'] })
  → queryClient.invalidateQueries({ queryKey: ['agents'] })
  → React Query 自动后台 refetch
  → 仅变更的 DOM 节点更新
```

### Query Key 设计

```ts
const queryKeys = {
  overview:    ['overview'],
  topics:      (filters) => ['topics', filters],
  agents:      ['agents'],
  topicDetail: (p, w, t) => ['topic', p, w, t],
  agentDetail: (name) => ['agent', name],
  health:      ['ops', 'health'],
  events:      (filters) => ['events', filters],
};
```

### SSE Hook

```ts
function useSSE() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/events');
    es.addEventListener('update', () => {
      queryClient.invalidateQueries();  // 全量 invalidation，简单可靠
    });
    return () => es.close();
  }, [queryClient]);
}
```

---

## 7. CSS 迁移策略

### 方案：CSS 变量 + 全局样式 + CSS Modules（按需）

1. **提取 CSS 变量**：从 board.mjs 的三个 `<style>` 块中提取统一的 `variables.css`
2. **全局样式**：`global.css` 包含 reset、body、`.shell`、`.sidebar`、`.main` 等布局样式
3. **组件样式**：简单组件用全局 class，复杂组件用 CSS Modules 隔离

### CSS 变量提取

```css
:root {
  --bg-deep: #0a0e17;
  --bg-base: #111827;
  --bg-card: #1a2332;
  --bg-hover: #243044;
  --text-primary: #e2e8f0;
  --text-muted: #64748b;
  --accent-blue: #3b82f6;
  --accent-green: #10b981;
  --accent-amber: #f59e0b;
  --accent-red: #ef4444;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  /* ... 完整提取 */
}
```

### 可选：Tailwind CSS

如果团队偏好 utility-first，可引入 Tailwind 替代手写 CSS。CSS 变量仍保留用于主题 token。

---

## 8. server.mjs 改造

### 移除
- `import * as board from './board.mjs'`
- `renderApp()`、`renderTopicPage()`、`renderAgentPage()` 调用
- `parseFlash()` 函数
- `flashStore` 及相关逻辑
- GET `/`、`GET /topic/*`、`GET /agent/*` 的 HTML 渲染逻辑

### 修改
- 三个 POST 端点改为返回 JSON（不再 redirect）
- 新增 static file serving：`dist/` 目录

### 新增

```js
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');

// SPA fallback: 非 /api、非 /events、非 /ops 的 GET 请求 → index.html
function serveSPA(request, response) {
  const indexPath = join(DIST_DIR, 'index.html');
  if (existsSync(indexPath)) {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(readFileSync(indexPath));
  } else {
    response.writeHead(404);
    response.end('Frontend not built. Run: npm run build');
  }
}

// Static assets: /assets/*
function serveStatic(request, response) {
  const filePath = join(DIST_DIR, request.url);
  if (existsSync(filePath) && !filePath.endsWith('.html')) {
    const ext = filePath.split('.').pop();
    const types = { js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png' };
    response.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    response.end(readFileSync(filePath));
  } else {
    serveSPA(request, response);
  }
}
```

---

## 9. Vite 配置

### `vite.config.mjs`

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4319',
      '/events': 'http://127.0.0.1:4319',
      '/ops': 'http://127.0.0.1:4319',
    },
  },
});
```

### 开发模式

```bash
# 终端 1：启动 API 服务器
node src/server.mjs

# 终端 2：启动 Vite 开发服务器（代理 API 请求）
npx vite
```

### 生产模式

```bash
npm run build    # vite build → dist/
node src/server.mjs  # server 同时 serve dist/ 和 API
```

---

## 10. 依赖清单

### 新增 `package.json` dependencies

```json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "@tanstack/react-query": "^5.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^6.0.0",
    "typescript": "^5.7.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@testing-library/react": "^16.0.0",
    "vitest": "^3.0.0"
  }
}
```

### 保持零依赖的后端

`server.mjs`、`handoff-store.mjs`、`state.mjs`、`trace-store-view.mjs` 仍为纯 Node.js ESM，无 npm 依赖。

---

## 11. 增量迁移步骤

### Phase 0: 准备 ✅ 完成

1. ✅ 初始化 `package.json`、`vite.config.mjs`、`tsconfig.json`
2. ✅ 创建 `src/client/` 目录结构和入口文件
3. ✅ 提取 CSS 变量到 `variables.css` + `global.css`
4. ✅ 修改三个 POST 端点返回 JSON（保持 redirect 兼容：检查 `Accept` header）
5. ✅ 验证所有 `/api/*` 端点可用

### Phase 1: 主面板骨架 ✅ 完成

1. ✅ 实现 `<Shell>` + `<Sidebar>` + React Router
2. ✅ 实现 `<OverviewCards>` 消费 `/api/overview`
3. ✅ 实现 `<TopicsView>` 消费 `/api/topics`（表格 + 排序 + **服务端分页**）
4. ✅ 实现 `<AgentsView>` 消费 `/api/agents`（卡片网格）
5. ✅ 实现 `<OpsView>` 消费 `/api/ops/health`（三个表单 + JSON 响应处理 via useMutation）
6. ✅ 实现 `useSSE` hook → `queryClient.invalidateQueries()`
7. ✅ 实现 `<FilterPanel>` + URL search params 状态管理
8. ✅ 验证：主面板功能与当前等价

### Phase 2: 详情页 ✅ 完成

1. ✅ 实现 `<TopicDetailPage>` 消费 `/api/topic/*`
2. ✅ 实现 `<AgentDetailPage>` 消费 `/api/agent/*`
3. ✅ 实现合并时间线渲染
4. ✅ 实现剪贴板复制（CopyButton）
5. ✅ 修复 SPA fallback 路由 bug（添加 `/api/*`、`/events`、`/ops/*` 排除守卫）
6. ✅ 修复 workspace 路径含 `/` 导致 React Router 匹配失败（改用 topic key 作为 URL 参数）
7. ✅ 验证：详情页功能与当前等价

### Phase 3: 集成与清理 ✅ 完成

1. ✅ server.mjs 添加 SPA fallback 和 static serve（含 `/api/*` 排除守卫）
2. ✅ 构建生产版本，验证完整功能

### Phase 4: 增强体验 ✅ 完成

1. ✅ SSE 触发 React Query invalidation（精细化按事件类型 invalidation + 连接状态指示器）
2. ✅ Ops 表单 toast 通知（成功/失败反馈，替代 flash 机制）
3. ✅ 主题切换（暗色/亮色，localStorage 持久化，`g d` 快捷键）
4. ✅ 键盘快捷键（`g t/a/o` 导航，`g d` 主题，`Esc` 返回）
5. ✅ 组件测试覆盖（23 tests：routing utils, Toast hook, Badge 组件）

### Phase B: 功能增强 ✅ 完成

1. ✅ **B-1**: Topic 详情页 timeline 筛选 chips（All/Handoffs/Events/Traces，URL search params 同步状态）
2. ✅ **B-2**: Agent 详情页增加 "Recent handoff conclusions" 区块（最近 10 条 handoff 记录，含结论预览和 next action）
3. ✅ **B-3**: Topic 详情页快速操作按钮（Heartbeat / Mark blocked / Claim / Release，一键发布 agent event）

### Phase Cleanup: 移除遗留代码 ✅ 完成

1. ✅ 删除 `board.mjs`（48KB 服务端 HTML 模板，已完全被 React SPA 替代）
2. ✅ 移除 `flashStore` / `storeFlash` / `popFlash` 及 `randomUUID` 导入
3. ✅ 移除 `HANDOFF_BOARD_UI=legacy` 分支及 `UI_MODE` 变量
4. ✅ 移除 `sendHtml` / `redirect` / `wantsJson` 辅助函数
5. ✅ POST 端点统一返回 JSON（不再需要 Accept header 协商）
6. ✅ 更新 `package.json` check 脚本和 README 移除 legacy 引用

### Phase E2E: 端到端冒烟测试 ✅ 完成

1. ✅ `test/e2e.test.mjs`：启动服务器 → 验证 7 个关键端点（overview, topics, agents, health, filter-options, SPA fallback, 404 handling）
2. ✅ 新增 `npm run test:e2e` 脚本

---

## 12. 风险与缓解

| 风险 | 缓解 |
|------|------|
| API 响应格式与前端类型不匹配 | 从 `/api/*` 响应生成 TypeScript 类型，或手写类型并添加集成测试 |
| SSE 在 Vite proxy 下行为异常 | 开发时直连 API 服务器（CORS），或验证 Vite SSE proxy |
| 生产环境 static serve 性能 | 本地单用户场景，Node static serve 足够；无需 CDN |
| 迁移期间功能回退 | Phase 1-2 期间保留 board.mjs fallback，通过环境变量切换 |
| CSS 迁移遗漏样式 | 逐页对比截图，确保视觉一致 |

---

## 13. 迁移完成状态

迁移已完成，legacy 服务端渲染路径已完全移除。当前架构为纯 React SPA + JSON API：

- 前端：React 19 + React Router 7 + TanStack Query 5 + Vite 6
- 后端：纯 Node.js ESM（零 npm 依赖），仅提供 API + SSE + static serve
- 测试：23 组件测试 + 5 状态推导测试 + 7 E2E 冒烟测试

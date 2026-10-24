已归档：2026-10-24，现行设计见 [界面规范](../ui-norms.md)。

# 界面一致性实现记录

本轮依据 `ui-norms.md`、`app-structure.md` 和 reference 截图检查代码。没有启动浏览器或 Playwright，没有修改研究目录、数据库、迁移、路由和后端；所有变更留在工作区。以下是代码检查结果，视觉和键盘实测由负责人完成。

## 按设计条目完成

| 条目 | 修正 |
| --- | --- |
| 标题与动作区 | 资料全部/在读/未读/已读、发现、自定义五页、定时任务列表/新建/详情统一 24px strong 标题、32px 内边距、960px 最大宽度和 24px 内容间距。搜索统一为 32px 高胶囊。设置各页补主标题，单页分组不再重复标题。 |
| 文案 | 移除安装说明、安装体积提示、云同步范围说明、引用补全提示和确认框 description。发现页摘要保留在预览，列表不再重复摘要和推荐理由。缩短空状态和错误文案；中英文同步。角色正文、手册规则、论文摘要等实际内容保留。 |
| 静态信息 | 默认模型/机器等状态用普通文字；去掉未使用的禁用“新建任务”占位入口。保留真正立即生效的开关；定时任务需保存的暂停状态使用 checkbox。 |
| 名称与图标 | 资料页、空状态、侧栏的“导入”使用 FileUp；添加/新建使用 Plus；编辑、查看、移除等菜单动作统一 Lucide 图标。侧栏/按钮 16px 图标、列表 13px、元数据 12px。 |
| 主动作与菜单 | 每页至多一个 primary。模型页以添加模型为主动作，批量导入收进菜单。任务详情、论文详情、分享链接和凭据的次要/危险动作收进菜单，危险动作在最后并确认。数据页的两个安装按钮均为 secondary。 |
| 对话框 | 统一圆角，标题一行，表单保留标签和错误，导入/重命名/实验追踪补取消和保存；模型与论文重命名支持 Enter 提交。全局下载弹窗使用共享 Dialog/Button，移除说明并同步双语。共享 ui 组件原有接口未变。 |
| 焦点 | 搜索、菜单项、侧栏图标、开关、原生 select、列表链接补齐 token 焦点样式；悬停隐藏的菜单在键盘聚焦时显示，触屏保持可见。 |
| 加载与空状态 | 管理页加载改骨架；手册通过共享样式显示骨架，未改研究源文件。空列表居中图标与短标题。阅读器代码加载阶段使用骨架。 |
| tokens | 管理页尺寸、间距、字重、圆角、搜索、侧栏、阅读器顶栏等改用 tokens；面板和卡片 12px、对话框 16px、按钮/输入框 8px。 |
| 深色与 720px | 静态颜色改为主题变量，动作区随容器换行，长名称截断或折行，列表/详情约束宽度，滚动页保留相同 gutter。阅读器只改侧栏和顶栏外壳。实际效果待浏览器复核。 |

## 调整与原因

- 定时任务有数据时增加可搜索的主区列表，无任务时保留建议卡片；使右上角搜索具备实际用途。
- 实验追踪的模式、项目、密钥改为统一保存，取消不提交；原实现的切换/失焦保存与保存按钮混用。
- 批量导入成功后直接清理并关闭，修复原来 busy 保护拦住成功关闭的问题。
- 移除 AppShell 内重复的语言 Provider，使用 main 根 Provider，使设置切换语言与全局下载弹窗一致。
- 手册空状态使用共享 CSS 的 Lucide Archive mask，兼容已有列表标记，避免改研究目录。
- CSS 查询断点保留字面量；原生 media/container 条件不能使用 CSS 变量。动态百分比保留为数据计算。

## 测试

按要求顺序运行：

1. `.venv/bin/python -m pytest -q -n 0 backend/tests/test_research_schedules.py backend/tests/test_discovery.py backend/tests/test_library_collections.py backend/tests/test_model_options.py backend/tests/test_cloud_link.py`：50 passed。
2. `.venv/bin/python -m pytest -q`：1454 passed，18 skipped，5 failed，8 warnings。
3. `npm run check`：通过，1500 个中英文 key，TypeScript 与格式检查通过。
4. `npx vitest run`：因共享依赖目录的写权限启动失败；`npx vitest run --configLoader runner --no-cache`：44 个文件、339 项通过。
5. `npm run build`：同一写权限失败；等效执行 `tsc -b`、`vite build --configLoader runner`、`node scripts/copy-docs.mjs`：通过。构建有 vendor chunk 超过 500kB 的体积警告。

后端失败原文：

```text
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[15]
FAILED backend/tests/test_local_lifecycle.py::test_signal_stops_the_cli_and_every_worker[1]
FAILED backend/tests/test_local_lifecycle.py::test_workers_leave_when_the_cli_is_killed
FAILED backend/tests/test_local_lifecycle.py::test_a_killed_worker_is_restarted_and_health_says_so
FAILED backend/tests/test_research_host.py::test_the_probe_names_this_machines_chip
5 failed, 1454 passed, 18 skipped, 8 warnings in 122.30s (0:02:02)
```

前四项的错误原文：

```text
E                   PermissionError: [Errno 1] Operation not permitted: 'ps'
```

芯片探测的错误原文：

```text
>           assert info["chip"]
E           AssertionError: assert ''
```

标准 Vitest / build 的首次失败为 `EPERM`，尝试写入指向主仓库的 `frontend/node_modules/.vite-temp/`。未修改共享依赖或构建配置，使用 runner 和禁用测试缓存绕过写入。

完整日志：[pytest](../../../test-results/ui-polish/pytest-full.log)、[相关 pytest](../../../test-results/ui-polish/pytest-related.log)、[Vitest 首次失败](../../../test-results/ui-polish/vitest-original.log)、[构建首次失败](../../../test-results/ui-polish/build-original.log)、[前端检查](../../../test-results/ui-polish/npm-check.log)、[Vitest runner](../../../test-results/ui-polish/vitest-runner.log)、[构建 runner](../../../test-results/ui-polish/build-runner.log)。日志位于忽略的 test-results 目录。

## 负责人浏览器验收

新增 `frontend/e2e/screens/ui-consistency.spec.ts`，包含深/浅色 × 1440/720px、各管理页标题/主按钮/溢出检查、导入与危险菜单键盘流程、实验追踪取消、阅读器窄窗口外壳。研究接口和机器探测全部 mock，不会发起真实研究、模型或 SSH 调用。已有相关 E2E 选择器和 e2e-ui 的尺寸/圆角断言同步调整，本轮没有运行。

重点复核：

- 原生桌面窗口在 720px 下的标题、动作区、侧栏浮层与关闭按钮；深浅色下搜索和状态对比度。
- 资料各分类、列表/卡片、导入对话框与导入进度；长论文名、长来源和时间列。
- 任务列表搜索、建议卡片、新建表单、详情保存、暂停/继续与删除确认；浏览器验收使用 mock 或隔离数据。
- 手册空状态/加载/规则详情、研究角色只读详情；机器状态与菜单；实验追踪的取消/保存；模型添加、批量导入成功关闭和重命名。
- 设置五页与全局下载弹窗切换英文；Tab、Shift+Tab、Enter、Escape、菜单箭头及关闭后焦点返回。
- 阅读器只检查侧栏/顶栏：长标题、窄窗口折叠菜单、页码输入和右侧面板开关。

合并时关注共享文件 `AppSidebar.tsx` 和两份 i18n catalog；`routes.ts`、`research_routes.py`、`models.py` 未修改。没有数据库迁移。开始时已有的未跟踪 `.venv` 保持不动。没有未完成的代码项；浏览器视觉与键盘实测仍待验收。

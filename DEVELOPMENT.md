# ServerLens 开发文档

ServerLens 是面向 AI 科研人员的 VS Code 多服务器资源监控插件。它基于 GPU Fleet Viewer 1.4.3 二次开发，在保留 GPU 监控能力的基础上，增加多磁盘、CPU、内存、配额和目录容量分析。

本文记录源码分析结论、技术决策、架构和任务进度。用户文档见 [README.md](README.md)，测试结果见 [docs/TEST_REPORT.md](docs/TEST_REPORT.md)。

## 1. 源码分析（Phase 1）

### 1.1 两个参考项目

| 项目 | GPU Server Viewer | GPU Fleet Viewer |
|---|---|---|
| 仓库 | github.com/Riku-0801/gpu-server-viewer | github.com/yruichen/gpu-fleet-viewer |
| 检查的版本 | 1.0.2，commit `1f10dd2`（2025-11-19） | 1.4.3，commit `b656387`（2026-10-19） |
| 许可证 | Apache-2.0 | Apache-2.0，NOTICE 声明派生自 GPU Server Viewer |
| 代码量 | 约 700 行 TypeScript | 约 4300 行 TypeScript，另有约 1300 行测试脚本 |
| SSH 调用 | `cp.exec("ssh " + host + " nvidia-smi -q -x")`，字符串拼接，没有超时 | `execFile('ssh', args)`，BatchMode、ConnectTimeout、整体超时、AbortSignal、并发上限、失败退避 |
| GPU 数据 | 型号、利用率、显存、温度 | 另有功耗、风扇、计算进程（用户、PID、命令、显存）、Slurm 作业 |
| 主机数据 | 无 | load、内存（MemAvailable）、根分区、uptime |
| 界面 | TreeView 加 WebviewPanel，每次刷新整页重写 HTML | TreeView 加 WebviewPanel，按 key 做 DOM 补丁（不闪烁），CSP、中英文、设置对话框、状态栏 |
| 测试 | 无可运行测试 | `npm test` 覆盖解析、刷新合并、退避、jsdom 界面测试，本机实测全部通过 |
| 其他 | 无 | AI 助手、任务溯源、GPU 释放提醒（约 1500 行，依赖 markdown-it），推送 main 即自动发布 Marketplace 的工作流 |

需求里“保留原有功能”列出的功耗展示和 GPU 进程查看，只有 GPU Fleet Viewer 实现了。它的 SSH 调用也已有超时、并发上限和退避，所以选它作为基础。

### 1.2 可复用的模块

| 文件 | 内容 | 处理方式 |
|---|---|---|
| `sshConfig.ts` | SSH config 解析，支持一行多个别名、引号、`Match` 块 | 保留 |
| `serverProvider.ts` | 侧边栏 Servers 树，含 Dashboard 入口和内联 Connect 按钮 | 保留，树节点增加状态描述 |
| `gpuMonitor.ts` | nvidia-smi CSV 解析、进程归属（`ps`）、Slurm 关联 | 保留解析；SSH 执行移到统一传输层 |
| `fleetModel.ts` | GPU 可用性判定、同一物理机去重、全局汇总 | 保留，扩展数据类型 |
| `webviewTemplate.ts` | `patchChildren` 键值 DOM 补丁、Lucide 图标、进度条、`t()` 翻译 | 抽出共享部分，侧边栏卡片复用 |
| `preferences.ts`、`preferencesView.ts` | 设置字段定义、校验和设置对话框 | 保留，增加新字段 |
| `gpuView.ts` | 仪表盘面板 | 保留界面，数据改由 MonitorService 提供 |

### 1.3 原项目与需求之间的差距

1. 每次刷新都新建一次 SSH 连接，没有复用。每个面板各自轮询，侧边栏和仪表盘同时打开时会重复查询。
2. 磁盘只有 `df -Pk /`，没有多挂载点、网络存储和配额。
3. CPU 只有 load，没有使用率、核心数和 Swap。
4. nvidia-smi 失败时整台主机被判为错误，没有 NVIDIA GPU 的服务器无法显示 CPU、内存和磁盘。
5. 远程命令直接交给用户的登录 shell 解释，登录 shell 是 fish 或 tcsh 时会失败；`.bashrc` 打印的内容会混进 GPU 输出。
6. 远程命令没有超时，网络存储挂死时 `df` 会一直卡住。
7. `~/.ssh/config` 里的 `RemoteForward`/`LocalForward` 会在每次监控连接时生效。常见的 SSH 配置会给主机设置 `RemoteForward`，监控连接可能先占用远端端口，导致用户自己的会话转发失败。
8. 所有数据共用一个刷新间隔。

## 2. 决策记录

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 以 GPU Fleet Viewer 1.4.3 为基础 | 见 1.1 节 |
| D2 | 移除 AI 助手、任务溯源、GPU 释放提醒及 markdown-it 依赖（用户已确认） | 需求未列出；这些模块会代用户在服务器上执行进程和日志查询，与“轻量、低资源占用”冲突。移除放在单独提交中，可从 git 历史恢复 |
| D3 | 保留上游 git 历史；`upstream` 指向 GPU Fleet Viewer 且禁用 push；`origin` 指向 `git@github.com:ziyisun85-ops/ServerLens.git`，不推送 | 保留署名，方便以后合并上游修复，避免误推到原作者仓库 |
| D4 | 新标识：包名 `serverlens`，publisher `ziyisun85-ops`，设置和命令前缀 `serverlens.*`，视图容器 `serverlens`。首次启动时把 `gpu-fleet-viewer.*` 的同名设置复制过来 | 与两个原插件同时安装也不冲突；老用户不用重新配置 |
| D5 | 删除自动发布工作流（`release.yml`、`resolveRelease.sh`、`checkRelease.js`、`docs/PUBLISHING.md`），保留 CI | 原工作流在推送 main 时自动发布 Marketplace，需求要求未经允许不发布。用户要求发布后另建了 `release.yml`（见 D25），发布仍需手动勾选或显式开启 |
| D6 | 连接复用用 OpenSSH ControlMaster：`ControlMaster=auto`、`ControlPersist`，控制套接字放在 `/tmp/serverlens-<uid>/%C`。目录权限 0700，使用前校验属主、类型和路径长度。Windows 版 OpenSSH 不支持，自动退回每次新建连接 | 继续使用系统 ssh，保留用户 config 的全部能力（ProxyJump、密钥、agent）。`/var/folders/...` 太长，会超过 Unix 套接字 104 字节的上限 |
| D7 | 监控连接加 `-T -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no -o RemoteCommand=none -o RequestTTY=no -o PermitLocalCommand=no -o LogLevel=ERROR` | 监控连接不应携带用户 config 中的端口转发和交互设置（见 1.3 第 7 条） |
| D8 | 远程脚本经 stdin 交给 `sh -s` 执行；脚本整体包在函数里，并以 `</dev/null` 调用；统一 `LC_ALL=C`；每段输出带随机 nonce 标记和退出码；存在 `timeout` 时每条命令都套上 | 与登录 shell 类型无关；`.bashrc` 的输出不会被误解析；不同语言环境输出一致；单个命令挂死不会拖住整次采集 |
| D9 | 统一调度：每台主机按各指标的到期时间，把到期的采集合并成一个脚本执行一次 SSH。默认 GPU、CPU、内存 5 秒，磁盘 60 秒 | 满足独立刷新频率，又只用一次 SSH 往返 |
| D10 | CPU 使用率用相邻两次 `/proc/stat` 采样的差值；第一次采样在脚本内间隔约 0.5 秒连续读两次 | 5 秒窗口比瞬时值稳定，第一次显示不用等下一轮 |
| D11 | 磁盘：`df -P -k -T`，失败时回退 `df -P -k`；过滤伪文件系统；按（设备, 总量, 已用, 可用）合并同一文件系统的多个挂载点；用户固定的路径用 `df <path>` 解析所属文件系统；`df` 超时时改用 `df -l` 只读本地盘，并提示网络存储可能无响应 | 覆盖 bind mount、btrfs 子卷、同一 NFS 导出挂载多次的情况；挂死的 NFS 不影响本地盘显示 |
| D12 | 配额：有 `quota` 命令时运行 `quota -v -w`，有 Lustre 挂载时运行 `lfs quota`；配额与 df 剩余空间分开展示 | 区分“磁盘还剩多少”和“我还能用多少” |
| D13 | 目录分析只能手动触发：`nice -n 19`、`ionice -c3`（存在时）、`timeout`、`du -x -k -d N`；可取消（结束本地 ssh，再按 PID 结束远端进程）；同一主机同时只允许一个扫描；只读，不提供删除 | 避免影响共享服务器 |
| D14 | 侧边栏新增 WebviewView “Monitor” 卡片视图，复用原项目的 DOM 补丁、图标、进度条和翻译机制；原 “Servers” 树和仪表盘面板保留 | 需求要求卡片式侧边栏，同时保留原有交互 |
| D15 | 去掉运行时依赖 xml2js：XML 解析路径只在测试里用到 | 插件运行时零第三方依赖，VSIX 更小 |
| D16 | 测试沿用上游约定：编译后用 node 直接运行断言脚本，界面用 jsdom 测试 | 与原项目一致，不引入新的测试框架 |
| D17 | 同一台物理机的多个别名（GPU UUID 相同）仍分别采集，只在 GPU 汇总里计一次 | 原实现直接跳过别名的采集；但不同别名可能是不同用户或不同容器，磁盘和配额不同 |
| D18 | nvidia-smi 超时一次后，该主机下一轮给 nvidia-smi 45 秒；一轮耗时很长的主机，采集间隔不小于本轮耗时的两倍（最多 5 分钟） | 在负载很高的共享服务器上 nvidia-smi 可能需要几十秒；固定 8 秒限制会让 GPU 永远显示不出来，而一直重试会持续占用服务器 |
| D19 | 状态栏点击打开侧边栏 Monitor 视图（原为打开仪表盘） | 侧边栏是新的主界面；仪表盘仍可从标题栏和 Servers 树打开 |
| D20 | 服务器超过 6 台时卡片默认折叠，用户展开后记住状态 | 服务器较多时全部展开过长 |
| D21 | 容量单位默认 IEC（GiB/TiB，1024 进制），可切换为 SI | 与 `df -h` 和 nvidia-smi 的数值一致 |
| D22 | 界面检查用 Chrome 无头模式渲染真实的 webview 代码和 VS Code 默认主题变量；仓库中不保存截图 | 开发期间没有在本机启动 VS Code 窗口；截图可能暴露服务器环境，不放进公开仓库 |
| D23 | 推送到 GitHub 时合并仓库自带的初始提交（只有一行 README），快进推送，不强制推送；首次推送前把文档中的实验室主机名和本机细节换成中性描述（只改文档） | 公开仓库不应暴露内部基础设施命名 |
| D24 | 发布前用工作流做一次审查：两路调研（市场规则、名称可用性）、三个审查视角（清单与市场页面、真实 VS Code 运行、安全与隐私），每个视角的发现再由独立的复核者尝试推翻。确认 15 项，其中 1 项经核实不成立（上游链接实际可用），其余 14 项已修复 | 首次公开发布，且此前未在真实 VS Code 中运行过 |
| D25 | 发布方式：Trusted Publishing（OIDC，`vsce publish --oidc`）。推送 `v<版本>` 标签即发布（用户要求“打 tag 即发布”）；发布者未设置时发布任务失败并给出提示，设置后重跑即可；首个版本也可在网页上传 VSIX。不使用 PAT。工作流分为 build（只读）、github-release（可写）、publish（只能换取发布凭据）三个任务，安装和测试依赖时不持有任何写权限 | 全局 PAT 将停用（2027-01-27，部分文档写 2026-12-01），微软推荐 Trusted Publishing；仓库中不保存任何令牌 |
| D26 | `@vscode/vsce` 升级到 4.1.x | `--oidc` 需要 4.1.0 或更高版本 |
| D27 | `engines.vscode` 提高到 `^1.82.0`，`@types/vscode` 固定为 `~1.82.0` | webview 使用 CSS `color-mix()`，VS Code 1.80/1.81 的 Chromium 108 不支持；固定类型版本后，编译器会拒绝 1.82 之后才有的 API |
| D28 | `activationEvents` 设为 `onStartupFinished`，激活后立即按设置启动调度 | 状态栏和 `pauseWhenHidden=false` 时的后台采集在启动后即可用；默认仍只在视图可见时采集 |
| D29 | 标记为 Preview | Windows、真实的 quota/lfs 输出、Slurm 等尚未验证 |
| D30 | 在 CI（Ubuntu 24.04 + xvfb）里用 `@vscode/test-electron` 在真实 VS Code 1.82.0 和最新稳定版中运行扩展测试 | 验证激活、命令、两个 webview 在真实 CSP 下加载、命令参数形态，而不需要在开发机上打开窗口 |

## 3. 架构

```text
extension.ts            激活、命令、状态栏、设置迁移、停用清理
 ├─ MonitorService      monitorService.ts：按主机调度、合并批量命令、缓存、并发上限、退避、事件
 │   ├─ SshTransport    sshTransport.ts：ssh 参数、ControlMaster 复用、超时、取消、停用时关闭连接
 │   ├─ remoteScript.ts 生成批量 POSIX sh 采集脚本和 du 脚本
 │   └─ 解析            gpuMonitor.ts（GPU）、hostMetrics.ts（CPU/内存/系统）、diskMetrics.ts（磁盘/配额）
 ├─ DiskAlerts          diskAlerts.ts：阈值、滞回、静音和稍后提醒
 ├─ StorageAnalyzer     storageAnalyzer.ts：手动触发的目录容量分析
 ├─ SidebarView         sidebarView.ts + sidebarTemplate.ts：侧边栏服务器卡片
 ├─ GpuViewPanel        gpuView.ts + webviewTemplate.ts：仪表盘面板（原有）
 └─ GpuServerProvider   serverProvider.ts：Servers 树（原有）
```

数据流：MonitorService 是唯一会发起 SSH 的地方（目录分析除外，它也走同一个 SshTransport）。采集结果先解析成 `fleetModel.ts` 中的类型，再由侧边栏和仪表盘各自渲染。两个视图都不可见时，自动刷新暂停（可在设置中关闭）。

一次采集的远程脚本结构：

```sh
main() {
  # 每段：标记行 @@SL:<nonce>:<段名>@@，正文，"#rc <退出码>"
  gpu      nvidia-smi --query-gpu=...         （到期时）
  gpuproc  nvidia-smi --query-compute-apps=... 与 ps 详情
  cpu      /proc/stat、/proc/loadavg、nproc   （到期时）
  mem      /proc/meminfo                      （到期时）
  sys      uname、/etc/os-release、/proc/uptime、/proc/cpuinfo（随磁盘频率）
  df       df -P -k -T 及固定路径             （到期时）
  quota    quota -v -w、lfs quota             （随磁盘频率，可关闭）
}
main </dev/null
```

## 4. 文件说明

| 文件 | 作用 | 来源 |
|---|---|---|
| `src/extension.ts` | 激活、命令、设置迁移、停用清理 | 修改 |
| `src/sshTransport.ts` | ssh 参数、连接复用、超时、取消、错误分类 | 新增 |
| `src/remoteScript.ts` | 批量采集脚本、输出分段、路径引号 | 新增 |
| `src/monitorService.ts` | 调度、合并、并发、退避、暂停、事件 | 新增 |
| `src/gpuMonitor.ts` | nvidia-smi、ps、Slurm 解析 | 修改（保留原解析代码） |
| `src/hostMetrics.ts` | CPU、内存、系统信息解析 | 新增 |
| `src/diskMetrics.ts` | df、/proc/mounts、quota、lfs quota 解析和磁盘报告 | 新增 |
| `src/alerts.ts`、`src/notifications.ts` | 磁盘提醒、GPU 通知、状态栏 | 新增（GPU 通知逻辑移自原 gpuView.ts） |
| `src/storageAnalyzer.ts`、`src/storageCommand.ts` | 目录分析和命令交互 | 新增 |
| `src/sidebarView.ts`、`src/sidebarTemplate.ts` | 侧边栏卡片视图 | 新增 |
| `src/webviewShared.ts`、`src/format.ts` | 两个 webview 共用的 DOM 补丁和格式化函数 | 新增（DOM 补丁移自原 webviewTemplate.ts） |
| `src/settings.ts`、`src/serverActions.ts` | 读取设置；收藏、分组、终端等操作 | 新增（操作移自原 gpuView.ts） |
| `src/gpuView.ts`、`src/webviewTemplate.ts` | 仪表盘 | 修改 |
| `src/serverProvider.ts`、`src/sshConfig.ts` | Servers 树、SSH config 解析 | 修改 / 未改 |
| `src/preferences.ts`、`src/preferencesView.ts` | 仪表盘设置对话框 | 修改 |

## 5. 任务进度

### Phase 1：源码分析
- [x] 检查两个原始项目的架构、功能和许可证
- [x] 在本机构建并运行 GPU Fleet Viewer 的测试（全部通过）
- [x] 创建独立仓库（保留上游历史，禁用 upstream push）
- [x] 编写本文档

### Phase 2：核心功能
- [x] 移除 AI 助手、任务溯源、提醒和自动发布工作流
- [x] 更新插件名称、标识符、设置前缀，迁移旧设置
- [x] SshTransport：连接复用、超时、取消、清理
- [x] 批量远程脚本与 GPU/CPU/内存/磁盘/配额解析
- [x] MonitorService：独立刷新频率、并发、退避、防重叠
- [x] 磁盘容量预警
- [x] 侧边栏卡片视图；仪表盘和 Servers 树接入新数据

### Phase 3：界面与性能
- [x] 卡片布局、折叠、悬停详情、窄宽度适配、浅色和深色主题
- [x] 目录容量分析
- [x] 异常处理：无 GPU、命令缺失、输出异常、网络存储挂死、断线、nvidia-smi 过慢

### Phase 4：测试与交付
- [x] 解析单元测试、调度测试、传输层测试、界面测试、激活冒烟测试
- [x] 真实服务器只读集成测试（两台共享 GPU 服务器，Home 目录 du）
- [x] 类型检查、lint、构建、打包 VSIX（`releases/serverlens-0.1.0.vsix`）
- [x] README、配置文档、测试报告、改进说明（CHANGELOG）

未完成和无法验证的内容见 [docs/TEST_REPORT.md](docs/TEST_REPORT.md) 第 6 节。

## 6. 发布流程

- `.github/workflows/ci.yml`：推送和 PR 时运行 lint、单元测试、jsdom 测试、`vsce package`，以及在真实 VS Code 1.82.0 和 stable 中的扩展测试。
- `.github/workflows/release.yml`：推送 `v<版本>` 标签时运行全部测试并打包，把 VSIX 附到 GitHub Release，再用 Trusted Publishing 发布到市场；也可以从 Actions 页面对某个标签手动运行。
- 一次性设置和逐步说明见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 7. 开发环境与命令

```sh
# 需要 Node.js 20 或更高版本（开发时使用 Node 24 LTS）
npm ci
npm run compile     # TypeScript 编译到 out/
npm run lint
npm test            # 12 个测试脚本，含 jsdom 界面测试
npm run test:vscode # 下载 VS Code 并在其中运行扩展测试（会打开一个窗口；CI 中在 xvfb 下运行）
npm run package     # 生成 releases/serverlens-<version>.vsix
```

预览：`npm run preview:build` 生成 `preview/index.html`（仪表盘）和 `preview/sidebar-*.html`（侧边栏），可直接用浏览器打开（目录已被 .gitignore 忽略）。仓库中不保存截图或其他图片（`.gitignore` 会挡住插件图标以外的图片文件）。

真实服务器检查（不在 `npm test` 中，只执行只读命令）：

```sh
node scripts/integration.js <ssh-host> [<ssh-host>...] [--du <ssh-host>]
```

`--du` 会对该主机的 Home 目录做一次深度 1、30 秒上限的 du 扫描，只在得到服务器使用者同意后使用。

## 8. 后续可做

- 配额：XFS 项目配额、BeeGFS、GPFS。
- 磁盘 inode 使用率（小文件数据集常见的“空间够但 inode 用尽”）。
- 目录分析结果持久化，以及两次扫描之间的变化对比。
- 在 macOS/Windows 的 VS Code 中人工检查右键菜单、视图标题栏按钮和高对比度主题。

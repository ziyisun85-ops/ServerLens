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
7. `~/.ssh/config` 里的 `RemoteForward`/`LocalForward` 会在每次监控连接时生效。实验室常见的 SSH 配置会给每台主机设置 `RemoteForward`（开发时所用的配置里几乎每台主机都有），监控连接可能先占用远端端口，导致用户自己的会话转发失败。
8. 所有数据共用一个刷新间隔。

## 2. 决策记录

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 以 GPU Fleet Viewer 1.4.3 为基础 | 见 1.1 节 |
| D2 | 移除 AI 助手、任务溯源、GPU 释放提醒及 markdown-it 依赖（用户已确认） | 需求未列出；这些模块会代用户在服务器上执行进程和日志查询，与“轻量、低资源占用”冲突。移除放在单独提交中，可从 git 历史恢复 |
| D3 | 保留上游 git 历史；`upstream` 指向 GPU Fleet Viewer 且禁用 push；`origin` 指向 `git@github.com:ziyisun85-ops/ServerLens.git`，不推送 | 保留署名，方便以后合并上游修复，避免误推到原作者仓库 |
| D4 | 新标识：包名 `serverlens`，publisher `ziyisun85-ops`，设置和命令前缀 `serverlens.*`，视图容器 `serverlens`。首次启动时把 `gpu-fleet-viewer.*` 的同名设置复制过来 | 与两个原插件同时安装也不冲突；老用户不用重新配置 |
| D5 | 删除自动发布工作流（`release.yml`、`resolveRelease.sh`、`checkRelease.js`、`docs/PUBLISHING.md`），保留 CI | 原工作流在推送 main 时自动发布 Marketplace，需求要求未经允许不发布 |
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
| D18 | nvidia-smi 超时一次后，该主机下一轮给 nvidia-smi 45 秒；一轮耗时很长的主机，采集间隔不小于本轮耗时的两倍（最多 5 分钟） | 真实服务器上 nvidia-smi 被其他用户的查询拖到 28 秒；固定 8 秒限制会让 GPU 永远显示不出来，而一直重试会持续占用服务器 |
| D19 | 状态栏点击打开侧边栏 Monitor 视图（原为打开仪表盘） | 侧边栏是新的主界面；仪表盘仍可从标题栏和 Servers 树打开 |
| D20 | 服务器超过 6 台时卡片默认折叠，用户展开后记住状态 | 开发时所用的 SSH 配置有 40 多台主机，全部展开过长 |
| D21 | 容量单位默认 IEC（GiB/TiB，1024 进制），可切换为 SI | 与 `df -h` 和 nvidia-smi 的数值一致 |
| D22 | 截图用 Chrome 无头模式渲染真实的 webview 代码和 VS Code 默认主题变量 | 开发期间没有在本机启动 VS Code 窗口 |

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
- [x] README、配置文档、测试报告、改进说明（CHANGELOG）、截图

未完成和无法验证的内容见 [docs/TEST_REPORT.md](docs/TEST_REPORT.md) 第 6 节。

## 6. 开发环境与命令

```sh
# 需要 Node.js 20 或更高版本（开发时使用 Node 24 LTS）
npm ci
npm run compile     # TypeScript 编译到 out/
npm run lint
npm test            # 12 个测试脚本，含 jsdom 界面测试
npm run package     # 生成 releases/serverlens-<version>.vsix
```

预览和截图：`npm run preview:build` 生成 `preview/index.html`（仪表盘）和 `preview/sidebar-*.html`（侧边栏），可直接用浏览器打开。在 macOS 上运行 `scripts/screenshots.sh` 可重新生成 `docs/screenshots/`（需要 Google Chrome）。

真实服务器检查（不在 `npm test` 中，只执行只读命令）：

```sh
node scripts/integration.js <ssh-host> [<ssh-host>...] [--du <ssh-host>]
```

`--du` 会对该主机的 Home 目录做一次深度 1、30 秒上限的 du 扫描，只在得到服务器使用者同意后使用。

## 7. 后续可做

- 配额：XFS 项目配额、BeeGFS、GPFS。
- 磁盘 inode 使用率（小文件数据集常见的“空间够但 inode 用尽”）。
- 目录分析结果持久化，以及两次扫描之间的变化对比。
- 在真实 VS Code 中做一次端到端检查（`@vscode/test-electron`），确认右键菜单和视图标题栏按钮。

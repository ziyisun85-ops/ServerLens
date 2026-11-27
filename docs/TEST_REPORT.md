# ServerLens 测试报告

测试日期：2026-11-27（第 7 节为 2026-11-28）。本文只记录实际执行过的测试和实际看到的结果；没有执行或无法验证的内容列在第 6 节。各版本的改动见 CHANGELOG。为保护测试环境，本文不列出服务器的名称、地址和硬件配置，仓库中也不保存截图。

## 1. 测试环境

| 项目 | 版本 |
|---|---|
| 开发机 | macOS 26.6.2（arm64），OpenSSH_10.3p1 |
| Node.js | 24.22.3 LTS |
| TypeScript / ESLint / vsce | 按 `package-lock.json` 安装 |
| 本地 shell | `/bin/sh`（bash 3.2 POSIX 模式）、`/bin/dash`、`/bin/bash` |
| 真实服务器 | 两台多人共享的 Linux GPU 服务器 |

## 2. 自动化测试（`npm test`）

`npm run lint` 无错误、无警告；`npm test` 的 12 个脚本全部通过，连续运行 3 次结果一致。

| 脚本 | 覆盖内容 |
|---|---|
| `checkLocales.js`（原有） | 中英文翻译键一致（205 个） |
| `out/test/manual_test.js`（原有） | nvidia-smi CSV 解析、SSH config 解析、GPU 空闲判定、同机去重、汇总、800 张 GPU 的汇总性能 |
| `out/test/parsers_test.js` | `/proc/stat` 差值（含计数器回退、老内核字段）、`MemAvailable` 与旧内核估算、系统信息、`df -P -k -T` 解析（含空格挂载点、负的可用空间）、伪文件系统过滤、bind mount 与同一 NFS 导出去重、固定路径、`/proc/mounts` 转义、`quota -v` 折行与超额标记、`lfs quota`、单位换算、阈值边界、shell 引号、输出分段与 nonce |
| `out/test/collect_test.js` | 真实采集脚本分别在 sh、dash、bash 下运行（指向测试用的 `/proc` 文件和假的 nvidia-smi/df/quota/ps/lfs），经 MonitorService 解析；另测无 nvidia-smi、驱动故障、nvidia-smi 超时、网络盘导致 df 超时、df 不支持 `-T` 五种情况 |
| `out/test/transport_test.js` | 用假的 ssh 程序测试：脚本经 stdin 执行、安全选项、ControlMaster 参数与 0700 目录、符号链接/权限过宽/路径过长时的处理、5 类 ssh 错误分类、超时、取消、输出过大、非法主机名不会传给 ssh、停用时关闭共享连接、私钥内容不进入诊断信息 |
| `out/test/scheduler_test.js` | 假时钟下的调度：默认 5/5/5/60 秒、自定义间隔、到期指标合并为一次 SSH、同一主机不重叠、手动刷新合并、并发上限、失败退避与恢复、隐藏时暂停、df 超时后暂停磁盘采集、主机增删、停用 |
| `out/test/storage_alerts_test.js` | 在本机真实运行 `du` 的目录分析（排序、缺失目录、所在文件系统）、取消时按 PID 结束远端进程、同一主机只允许一个扫描；磁盘提醒的阈值、滞回、重启不重复、升级提醒、静音、稍后提醒、离线不提醒；GPU 通知冷却 |
| `checkRefresh.js`（重写） | 仪表盘接入共享监控：多次点击只多采集一次、只影响显示的设置不触发 SSH、GPU 可见范围、终端命令使用指定 SSH config 且不自动执行、可见性登记与释放 |
| `checkWebview.js`（原有，删去 AI 部分） | 仪表盘 jsdom 渲染、筛选、排序、进程检查器、设置对话框、离线服务器分组 |
| `checkSidebar.js` | 侧边栏 jsdom：各状态卡片、70/90 阈值颜色及自定义阈值、数据更新时复用 DOM 节点（不闪烁）、折叠、详细信息、目录分析结果与取消、重试按钮、HTML 注入被当作文本、中文界面、无服务器时的引导 |
| `checkActivation.js` | 用模拟的 VS Code API 激活插件：所有贡献的命令都已注册、从 GPU Fleet Viewer 迁移设置、侧边栏视图加载并收到数据、右键菜单命令参数校验、打开仪表盘、修改设置后刷新、停用 |

## 3. 真实服务器集成测试

经服务器使用者同意，只连接了两台共享 GPU 服务器，只执行只读命令，并对其中一台的 Home 目录做了 du 扫描。使用脚本 `scripts/integration.js`（真实 ssh、开发者的 `~/.ssh/config`、连接复用开启）。

| 项目 | 结果 |
|---|---|
| GPU | 两台的所有 GPU 都正确显示；计算进程的用户全部解析成功 |
| CPU、内存、系统信息 | 使用率、核心数、负载、内存（含 MemAvailable）、系统和内核版本、运行时间都正确读取 |
| 磁盘 | 本地盘、NFS 和 sshfs 网络盘都能识别，网络盘被标为网络存储；同一文件系统的多个挂载点被合并；伪文件系统被隐藏；固定路径 `~` 解析到所在的文件系统 |
| 配额 | 两台服务器都没有 `quota`/`lfs`，显示为不可用 |
| 一轮采集耗时 | 正常情况下约 1 秒 |
| 目录分析 | Home 目录（深度 1，30 秒上限）在 1 秒内完成，结果按大小排序，无不可读目录。第一次运行时终端输出被截断，无法确认那次是否已执行到扫描，因此又运行了一次，扫描共执行了一次或两次 |

测试中发现两个问题，均已修复：

1. **nvidia-smi 很慢**：其中一台服务器上同时有大量 nvidia-smi 查询在等待驱动，单次查询需要几十秒。原实现（8 秒限制）下 GPU 一直显示“nvidia-smi did not respond in time”，但 CPU、内存、磁盘仍正常显示。现在超时一次的主机下一轮给 nvidia-smi 45 秒，采集间隔不小于本轮耗时的两倍；修改后 GPU 和进程都能正常显示。
2. **网络盘无响应**：一台服务器挂载的网络存储无响应时，`df` 会超时。现在回退为只读本地盘（不到 1 秒），卡片提示“df 超时，仅显示本地文件系统”。

连接复用、端口转发与清理：

| 检查 | 结果 |
|---|---|
| 第一轮之后 `ssh -O check` | 两台都返回 `Master running` |
| 插件停用后 `ssh -O check` | `No such file or directory`，共享连接已关闭 |
| 控制套接字目录 | `/tmp/serverlens-<uid>/`，权限 `drwx------` |
| 连接复用对耗时的影响 | 开启后每轮略快；主要时间花在远程命令本身 |
| 端口转发 | 测试所用的 SSH config 为主机配置了 `RemoteForward`。`ssh -G` 显示：不加 ServerLens 的参数时转发生效；加上后 `clearallforwardings yes`，转发被清除 |

## 4. 界面检查

用插件真实的侧边栏和仪表盘 HTML/CSS/JS 加载虚构的示例数据（`scripts/sidebarPreviewData.js`），注入 VS Code 默认 Dark Modern / Light Modern 主题的颜色变量，在 Chrome 无头模式下渲染并人工检查：深色、浅色、中文、230 像素窄侧边栏、展开详细信息，以及仪表盘。这不是 VS Code 窗口，字体和颜色与实际窗口可能有细微差别。仓库中不保存截图；运行 `npm run preview:build` 后可在浏览器中打开 `preview/` 下的页面查看。

人工检查结果：各状态颜色与图例一致；磁盘进度条在 93% 为红、75% 为黄、41% 为绿；230 像素宽度下 GPU 和 CPU 行的文字换到进度条下方，没有横向溢出；长命令和长路径以省略号截断，悬停可看全文。

## 5. 原有功能回归

| 原有功能 | 验证方式 | 结果 |
|---|---|---|
| 多服务器管理（SSH config、targets、additionalHosts、ignoredHosts） | manual_test、checkActivation、真实服务器 | 通过 |
| GPU 型号、利用率、显存、温度、功耗、风扇 | manual_test、collect_test、真实服务器 | 通过 |
| GPU 进程（用户、PID、命令、显存、运行时间）、Slurm | collect_test、checkWebview、真实服务器（Slurm 未在真实环境验证） | 通过 |
| 自动刷新、手动刷新、隐藏时暂停 | scheduler_test、checkRefresh | 通过 |
| 侧边栏 Servers 树、Dashboard 入口、Connect 按钮 | checkActivation（命令和视图注册） | 通过 |
| 仪表盘筛选、排序、收藏、分组、终端、设置对话框 | checkWebview、checkRefresh | 通过 |
| 状态栏、GPU 通知 | storage_alerts_test、checkActivation | 通过 |

## 6. 尚未实现或无法验证的内容

**无法验证（缺少环境或未获授权）：**

- 没有人在 macOS 或 Windows 的 VS Code 中实际使用过插件。插件已在 CI 的真实 VS Code（1.82.0 和最新稳定版，Linux + xvfb）中自动测试，见第 7 节；但那里只验证了激活、命令、两个 webview 的脚本能在真实的内容安全策略下加载，以及命令参数，没有检查画面。界面只在 Chrome 渲染中人工检查过。建议安装后先用一两台服务器试用。
- Remote-SSH、WSL、容器窗口中的行为（本地终端、设置的读取范围）是根据 VS Code 源码核对后实现的，没有在这类窗口中实际运行过。
- Windows：无 ControlMaster 时自动退回普通连接的逻辑只有代码路径，没有在 Windows 上运行过。
- 真实的 `quota` 和 Lustre `lfs quota` 输出：两台测试服务器都没有配额工具，解析只用按文档构造的样例测试过。
- 远端 `timeout` 杀掉卡住命令、取消扫描时远端结束 `du`：只在本机用假程序测过，真实服务器上的扫描很快完成，没有触发取消。
- Slurm、btrfs 子卷、CIFS、BeeGFS/GPFS、busybox 系统、没有 `MemAvailable` 的老内核：只有样例测试或没有测试。
- 高对比度主题：有对应 CSS，但没有渲染检查。
- 断线后自动重连：退避和恢复在调度测试中验证过；真实网络中断没有模拟。
- 同时监控几十台服务器时的本地资源占用没有测量。

**尚未实现：**

- XFS 项目配额、BeeGFS、GPFS 的配额查询。
- 目录分析结果只保存在内存中，重启 VS Code 后消失。
- 磁盘 inode 使用率。
- 目录清理或删除（按需求第一版只读）。

## 7. 发布前审查与真实 VS Code 测试（2026-11-28）

### 7.1 在真实 VS Code 中运行

`src/test/vscode` 中的测试由 `@vscode/test-electron` 下载 VS Code，在 GitHub Actions 的 Ubuntu 24.04 + xvfb 中运行扩展，检查：

1. VS Code 启动后扩展自行激活（`onStartupFinished`）；
2. 激活无错误，所有贡献的命令都已注册；
3. 从配置的 SSH config 文件（路径带首尾空格）解析出主机；
4. 连接一个拒绝连接的地址时报告为错误，而不是崩溃（同时验证 `ssh -F` 收到的是去掉空格后的路径）；
5. 侧边栏 webview 的脚本在真实的内容安全策略下执行到最后一行（发送 `ready`）；
6. 仪表盘 webview 同上；
7. 按服务器的命令接受字符串、树节点和 webview 右键菜单三种参数，非法主机名被忽略，剪贴板内容正确；
8. 修改设置后主机列表随之更新。

在 CI 中，VS Code 1.82.0、最新稳定版两个任务和单元测试任务全部通过。第 1、3 项是第二轮审查后加入或加强的，之后的运行会在 GitHub 的检查结果中留下“通过了几项检查、VS Code 版本”的注释。

### 7.2 两轮审查

- 第一轮（发布前）：两路调研（市场规则与发布方式、名称是否可用）和三个审查视角（清单与市场页面、真实 VS Code 运行、安全与隐私），每个发现再由独立的复核者尝试推翻。确认 15 项；其中“上游仓库链接失效”经实际访问不成立（旧地址会跳转到新地址），其余 14 项已修复，包括：通知文字中来自服务器的内容可能变成可点击的命令链接、Remote-SSH 窗口中的 GPU 终端打开在远程机器上、设置文件有未保存修改时激活失败、关闭一个窗口会断开其他窗口共用的 SSH 连接。
- 第二轮（复核修复）：确认 9 个问题，均已修复。最重要的一项是第一轮修复引入的回归：把 `sshConfigPath` 设为 machine 作用域后，Remote-SSH 窗口会忽略本机用户设置，已改为 application 作用域。其余为：路径首尾空格在解析和 `ssh -F` 之间不一致、手动运行发布流程时可以绕过标签检查、发布流程的构建步骤持有不必要的写权限和发布凭据权限（已拆分为三个任务）、文档中更换发布者 ID 的说明不完整、发布文档缺少推送标签这一步、Dependabot 会把 `@types/vscode` 升级到超过最低 VS Code 版本（会导致打包失败）、两项 VS Code 测试即使功能失效也会通过。


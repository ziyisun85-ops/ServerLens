# 发布到 VS Code 扩展市场

本文说明如何把 ServerLens 发布到 Visual Studio Marketplace。发布需要一个属于你的发布者（publisher）账号，这一步只能由你本人用 Microsoft 账号完成。代码、测试、打包和发布流程都已经准备好。

内容基于 2026 年 11 月的微软官方文档，来源见文末。

## 发布前检查

- 推送到 `main` 后，GitHub Actions 的 CI 全部通过：单元测试、jsdom 界面测试、在真实 VS Code（1.82.0 和最新稳定版，Linux + xvfb）中运行的扩展测试、`vsce package`。
- 推送 `v<版本>` 标签后，Release 工作流会再跑一遍全部测试，把 `serverlens-<版本>.vsix` 附在 [GitHub Releases](https://github.com/ziyisun85-ops/ServerLens/releases) 上，然后发布到市场。发布者和 Trusted Publishing 设置好之前，发布这一步会失败，但 GitHub Release 和安装包不受影响。
- 0.1.0 的标签 `v0.1.0` 已经推送，安装包在 Releases 页面上。

## 第一步：创建发布者（只需一次）

1. 用 Microsoft 账号登录 <https://marketplace.visualstudio.com/manage>。
2. 点击 **Create publisher**：
   - **ID** 填 `ziyisun85-ops`。它必须与 `package.json` 中的 `"publisher"` 一致，会出现在扩展 ID `ziyisun85-ops.serverlens` 和市场网址中，**创建后不能修改**。如果想用别的 ID：把 `package.json` 的 `publisher`，以及 `README.md`、`SUPPORT.md`、本文和 `.github/workflows/release.yml` 注释里的 `ziyisun85-ops` 都换成新 ID，把版本号提高（例如 0.1.1）后再按“以后发布新版本”推送新标签。
   - **Name** 是公开显示的名称，例如你的名字或 `ServerLens`。
3. 同意发布者协议，点击 **Create**。

## 第二步：发布

下面两种方式任选一种。方式 B 设置一次后，以后每次推送标签都会自动发布；如果方式 B 第一次发布失败，用方式 A 上传首个版本。

### 方式 A：在网页上传 VSIX

1. 从 [GitHub Releases](https://github.com/ziyisun85-ops/ServerLens/releases) 下载 `serverlens-0.1.0.vsix`。
2. 在 <https://marketplace.visualstudio.com/manage> 打开你的发布者，点击 **+ New extension** → **Visual Studio Code**，上传该文件。
3. 市场会先做安全扫描，扫描通过后扩展才会公开。可以在同一页面查看状态。

### 方式 B：GitHub Actions 自动发布（Trusted Publishing，不需要任何令牌）

1. 在发布者管理页面打开 **Trusted Publishing** → **Create**，填写：

   | 字段 | 值 |
   |---|---|
   | Repository owner | `ziyisun85-ops` |
   | Repository | `ServerLens` |
   | Workflow | `release.yml` |
   | Environment | 留空 |

2. 打开 <https://github.com/ziyisun85-ops/ServerLens/actions/workflows/release.yml>，进入 `v0.1.0` 那次运行，点击右上角 **Re-run jobs** → **Re-run failed jobs**。也可以点击 **Run workflow**，在 **Use workflow from** 中选择 **Tags** → `v0.1.0`，保持 **Publish to the Visual Studio Marketplace** 勾选后运行。手动运行只接受 `v` 开头的标签，选分支会直接报错，避免把未打标签的代码发布出去。
3. 发布任务执行 `vsce publish --oidc`。GitHub 签发的短期凭据只在这一次运行中有效，仓库里不保存任何令牌。

Trusted Publishing 在 2026-10-28 才推出，官方文档没有说明它能否完成一个全新扩展的**第一次**发布。如果第 2 步在发布环节失败，请用方式 A 上传 0.1.0，以后的版本再用方式 B。

## 以后发布新版本

1. 修改 `package.json` 的 `version`（只能是 `主.次.修订`，例如 `0.1.1`，不能带 `-beta` 之类的后缀），并在 `CHANGELOG.md` 顶部写本版本的改动。
2. 提交并推送，再推送同名标签：

   ```sh
   git tag v0.1.1
   git push origin v0.1.1
   ```

3. Release 工作流会测试、打包、创建 GitHub Release，并发布到市场。

## 不推荐：个人访问令牌（PAT）

过去发布需要一个 Azure DevOps 个人访问令牌，组织选 “All accessible organizations”，权限选 Marketplace → Manage。这种全局令牌正在停用：Azure DevOps 博客写的是 2027-01-27，VS Code 发布文档写的是 2026-12-01。微软已把 PAT 方式标为不推荐，所以本项目不再使用它。

## 不可撤销的操作

- 发布者 ID 创建后不能修改。
- 同一个版本号只能发布一次，删除后也不能再用；新的改动要提高版本号。
- 从市场删除扩展后，它的名字会被永久保留，连原发布者也不能再用。如果只是想暂时下架，用 **Unpublish**。
- 新发布者至少要 6 个月后才能申请认证标记（需要自己的域名）。

## 参考

- VS Code 文档：Publishing Extensions — <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>
- Trusted Publishing for the Visual Studio Marketplace（2026-10-28）— <https://developer.microsoft.com/blog/trusted-publishing-visual-studio-marketplace/>
- Azure DevOps：Retirement of Global Personal Access Tokens — <https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/>
- Extension manifest reference — <https://code.visualstudio.com/api/references/extension-manifest>

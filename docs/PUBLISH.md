# 发布检查清单（维护者）

适用于 GitHub 仓库 [Yuuuuuukit/magpie-opendesign-local-routing](https://github.com/Yuuuuuukit/magpie-opendesign-local-routing)。源码修复、验证、验收和公开发布分别确认；同一次明确授权覆盖的执行步骤连续完成。

## 原则

- 发布用的工作副本与 Magpie 的插件安装目录分开：不要在安装目录里 `git init` 或提交，旧版的加密凭据库可能就在里面。
- 仓库里只放源码、文档和虚构的测试数据。真实凭据、`.dpapi` 文件、`plugin-auth.json`、API 响应和日志不得进入仓库或发布包。

## 每次发布前

1. **干净的工作副本**：`git status` 里没有意外的文件；下面三个路径都应命中忽略规则：

   ```powershell
   git check-ignore -v opendesign-local-routing-vault/x.dpapi plugin-auth.json .env
   ```

2. **本地检查**：

   ```powershell
   npm run check
   npm test
   bun test --timeout 30000 ./tests   # 使用与 Magpie 相同的 Bun
   ```

3. **隔离宿主集成测试（可选但推荐）**：方法见 [验收状态](VERIFICATION.md)。
4. **打包清单**：`npm pack --dry-run --json --ignore-scripts` 列出的文件应包含 `LICENSE`、`NOTICE.md`、README 以及它引用的文档，且不含 `.dpapi`、`.env`、`plugin-auth.json`、日志或本机配置。
5. **敏感信息与隐藏字符扫描**：对即将提交的内容（`git ls-files`）搜索真实形态的 `vela_ctrl_` / `sk-amr-` 密钥、个人路径与邮箱、零宽和双向控制字符。测试文件里的虚构密钥除外。
6. **版本与记录一致**：`package.json` 的版本、`CHANGELOG.md`、`VERIFICATION.md` 的版本和状态要一致。运行代码有改动时，须重新做真实环境验收。
7. **提交与标签**：提交信息写清改动，按 main 保护规则通过 PR 合并；在目标提交的 CI 与 Gitleaks 通过后建立 `v<版本>` 标签，推送前确认远端状态，不使用 `--force`。版本、标签和附件必须对应同一提交。

## 桌面安装 ZIP

用 `git archive` 从已提交的内容生成：所有条目共用提交时间（不会出现 npm tar 的固定 1985 年时间戳），`.gitattributes` 里的 `export-ignore` 会排除 `.github/`、`.gitignore`、`.gitattributes` 和 `.gitleaks.toml`。

```powershell
git archive --format=zip --prefix=magpie-opendesign-local-routing/ -o ../magpie-opendesign-local-routing-<版本>-desktop.zip HEAD
```

生成后检查：根目录只有 `magpie-opendesign-local-routing/`，文件清单与 `npm pack --dry-run` 一致，条目日期对应目标提交时间（按 ZIP 本地时间表示，精度为 2 秒），不要求与实际打包当天相同。再在全新的目录里解压，运行一遍 `npm test`。

## 仓库公开前

- [ ] 保持 Private 直到安全验收通过。公开后在可用时启用 Private vulnerability reporting（Settings → Advanced Security），并确认 [安全说明](SECURITY.md) 中的报告渠道。
- [ ] GitHub Secret Protection / push protection 若当前个人 Private 仓库不可用，记录为“不适用”，不要为了寻找开关而提前公开；若可用则启用。
- [ ] 确认 [Gitleaks 扫描](SECRET_SCANNING.md) 的 PR / main 检查已通过，并执行全历史审计。扫描不能代替对已泄漏密钥的轮换；`.gitignore` 无法保护已经入库的内容。
- [ ] README 与 [验收状态](VERIFICATION.md) 的状态和实际一致，未完成的验收项如实保留。
- [ ] 阅读 OpenDesign 服务条款中关于多账号使用和接口访问的约定（这不是法律意见）。

## GitHub Release

1. 从最终标签对应的提交生成桌面 ZIP，按上文核对实际清单、文件字节、日期和解包测试。
2. 在 Releases 新建草稿，选择对应标签，填写版本变化、安装方式、已验证范围及已知限制，上传 `magpie-opendesign-local-routing-<版本>-desktop.zip`。
3. 正式版本不勾选 Pre-release；确认附件完整后发布。`1.0.3` 是首个正式版。
4. 读回 Release、标签、公开可见性、main 保护与私密漏洞报告状态，核对下载附件与本地包一致。

main 保护要求 PR、分支与 main 保持同步、处理未解决讨论，且以下 GitHub Actions 检查全部通过：`Node 22 (ubuntu-latest)`、`Node 22 (windows-latest)`、`Bun 1.4.4 (windows-latest)`、`Git history + working tree`。禁止强推、删除及常态绕过；单人维护暂不要求他人批准。

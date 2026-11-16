# Secret scanning / 密钥扫描

仓库为 GitHub 个人账号的 Private 仓库时，GitHub Secret Protection 可能不可用。本项目使用 GitHub Actions + Gitleaks 作独立防线；**这不等价于 GitHub 服务端的 push protection**。

## 自动运行

- Workflow: \`.github/workflows/secret-scan.yml\`
- 触发：main 分支 push、所有 PR、每周一 UTC 03:19、手动 workflow_dispatch
- 工具：Gitleaks v8.30.1（容器镜像固定 Linux amd64 digest）
- 扫描范围：checkout fetch-depth=0 后，\`git --log-opts="--all --full-history"\` 扫描所有已获取、可达的 Git 提交；另扫当前检出的文件
- 安全限制：扫描容器无网络、文件系统只读、\`--redact=100\`；不上传带有发现内容的报告 Artifact
- 规则：继承 Gitleaks 默认规则，并为 \`vela_ctrl_\`、\`sk-amr-\` 增加专用规则；对已知虚构测试值设置**精确白名单**，绝不按整个 tests 目录排除

**范围限制：** GitHub 删除或重写历史后，已经不可达的提交不在此次 \`--all\` 扫描之内。已经泄漏的密钥需要在 OpenDesign 平台**撤销/轮换**；把字符串从 HEAD 删除或让扫描变绿不能解决泄漏。

## 手动审计

在本地安装 Gitleaks v8.30.1，并在完整克隆中执行：

\`\`\`powershell
git fetch --all --tags --prune
gitleaks git --config .gitleaks.toml --log-opts="--all --full-history" --redact=100 .
gitleaks dir --config .gitleaks.toml --redact=100 .
\`\`\`

不要将未脱敏的扫描报告、真实密钥、账号配置、\`.dpapi\` 文件或完整 API 响应推送、复制到 Issue 或上传为 CI Artifact。

## 故障处理

1. 发现真实密钥：优先撤销/轮换对应 OpenDesign Control Key 或 Runtime Key。
2. 检查是否经由日志、CI Artifact、发布包、PR、分支或 git 历史扩散，并清理敏感副本。
3. 如是误报，优先修复测试数据；必须豁免时，将白名单收窄到**精确的虚构值 + 文件路径**，在 PR 中说明缘由。
4. 工作流通过后，建议在 GitHub Settings → Branches / Rulesets 将 Secret Scan 设为 main 的必过检查（如果仓库计划与权限允许）。

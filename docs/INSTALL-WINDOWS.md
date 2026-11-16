# Windows 安装与升级

仅适用于 Magpie（Windows）。插件文件夹应位于当前用户控制的稳定目录，避免共享可写或自动同步的目录：能修改插件源码的人，就能读取你的密钥。

## 新安装

1. 从 [v1.0.3 Release](https://github.com/Yuuuuuukit/magpie-opendesign-local-routing/releases/tag/v1.0.3) 下载 `magpie-opendesign-local-routing-1.0.3-desktop.zip` 并解压到新目录（也可克隆仓库），确认插件目录直接包含 `package.json`、`index.mjs`、`vault.mjs`。
2. Magpie → 插件 → 添加插件 → 本地文件夹，选择该目录。
3. 供应商 → **OpenDesign Local (DPAPI)** → 添加账号：备注名称、Control Key（`vela_ctrl_…`）、Workspace ID、Runtime Key（`sk-amr-…`，仅监控时留空）。各字段必须属于同一个账号。
4. 校对额度和重置时间，完成 [验收状态](VERIFICATION.md) 里的检查后，再迁移日常请求。

## 与旧版共存

本插件与旧版使用相同的 provider ID `opendesign-local`，**不能在同一个 Magpie 实例里同时启用**。需要保留旧版时，请使用独立的 Magpie 配置环境测试新版。

## 从旧版升级

1. 在插件页停用旧版，退出 Magpie（包括托盘）。
2. 备份：旧插件文件夹、Magpie 配置目录（含 `plugin-auth.json`），以及下一节列出的所有加密凭据目录（若存在）。
3. 用新版的文件覆盖旧插件文件夹里的源码，**不要删除**其中的 `.opendesign-local-routing-vault\`；或者把插件条目改为指向新文件夹。
4. 如果改用了新文件夹：v1.0.2 放在旧插件文件夹内的加密凭据不会被找到，插件也不会猜测或扫描其他路径。请在 Magpie 停止运行后，把旧文件夹中的 `.opendesign-local-routing-vault\` 复制到新插件文件夹的同名位置（必须是同一个 Windows 用户），或者重新添加账号。
5. 重启 Magpie，在插件页关闭再开启本插件，逐个账号检查额度、模型和登录状态；出现问题就用备份回滚。同一时间只启用一个版本。

## 凭据位置与旧版兼容

- **新凭据**：`<Magpie 配置目录>\opendesign-local-routing-vault\*.dpapi`。Magpie 的配置目录通常是 `%USERPROFILE%\.config\magpie`。
- **宿主未提供配置目录时**：`%LOCALAPPDATA%\Magpie\opendesign-local-routing-vault\`；环境变量缺失时，依次回退到 `APPDATA`、`USERPROFILE` 下的用户数据位置。
- **旧位置（只读）**：当前插件文件夹内的 `.opendesign-local-routing-vault\`（v1.0.2），以及 `%LOCALAPPDATA%\Magpie\opendesign-local-routing-vault\`（v1.0.1）。只有新位置找不到某个引用对应的文件时才会读取旧位置，插件不会扫描、搬移或删除任何文件。
- 凭据只能在**同一个 Windows 用户**下解密。

## 诊断

- **初始化失败**：记录版本和已脱敏的错误信息，不要上传账号配置。
- **没有模型**：先确认是不是仅监控账号，再确认 Runtime Key 是否有效。
- **登录失败**：错误信息会区分输入格式、控制端 HTTP 状态、Runtime Key 的 HTTP 状态和本地 DPAPI 故障。
- **账号显示已退出登录**：额度和 Runtime Key 都验证通过后，本插件会清除旧的失效标记，无需为此删除账号。额度能读取但 Runtime Key 被拒时，需要重新绑定；网络或 5xx 等临时故障会保持原状态。请先检查是否为同一个 Windows 用户、vault 文件权限和 API 权限，不要无依据地删除重建。
- **流式响应中断**：HTTP 200 之后出现超时或 ECONNRESET，需要结合宿主、代理与厂商链路来诊断，插件不会自动重放请求。排查时请记录 Magpie 日志（`%LOCALAPPDATA%\magpie\logs\app.log`）中的相关行（先去掉密钥和账号信息），并说明是否使用了本地代理（`HTTP_PROXY` / `HTTPS_PROXY`）。

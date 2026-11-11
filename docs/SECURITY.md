# 凭据与路由安全

Control Key 仅发送至 `https://amr-api.open-design.ai`，Runtime Key 仅发送至 `https://amr-link.open-design.ai` 的模型接口。所有请求都拒绝重定向，也不提供自定义目标主机的选项。

## 保存和读取

- 使用 Windows CurrentUser DPAPI 加密保存。异步 PowerShell 子进程只通过 stdin / stdout 收发数据；命令行参数是固定的静态脚本，不含密钥，也没有明文临时文件。
- 新的密文位于 Magpie 配置目录下的 `opendesign-local-routing-vault/`；宿主不提供目录时回退到 Windows 用户数据目录。
- Magpie 的账号记录只保存随机的 `vlt:` 引用、备注、Workspace ID 和用于去重的标识。备注和 Workspace ID 不是机密。
- 登录准备阶段只做验证，完成登录时才保存，并支持取消。缺失、损坏或字段无效的密文记录会阻止使用。
- v1.0.1 与 v1.0.2 的旧位置只读兼容，插件不会自动移动或删除其中的文件。

Windows 上的 POSIX 权限位（`0700` / `0600`）不能替代 ACL，插件也不会修改文件权限。请把 Magpie 配置目录和插件源码放在由你本人控制的位置。DPAPI 能防止其他用户直接解密静态文件，但不能保护已被控制的 Windows 用户，也不能保护被他人改写的插件源码。

## 已知限制

- Control Key 与 Runtime Key 是分别校验的，目前无法通过 `/models` 证明 Runtime Key 与 Control Key / Workspace 同属一个账号。请从同一个 Workspace 获取并填写，不要混填。
- 实时额度预检不是厂商侧的扣费上限，不能排除并发或长请求跨越套餐额度后产生钱包费用。
- 插件不会自动重试已经开始的流式回复，以避免重复的模型调用或工具执行。
- Magpie 没有可靠的插件登出清理钩子：重复登录，或在完成回调写入的瞬间取消登录，都可能留下孤立的密文文件。插件不按 `uid` 删除旧文件，因为它们可能仍被其他账号引用。确认不再使用某个账号、或卸载插件后，请自行备份并清理加密目录。
- 静态的 `-EncodedCommand` 是否会被某些 EDR 拦截，需要在目标机器上核实；插件没有明文后备，也不会改动执行策略。
- 加密目录位于 Magpie 的配置目录，该目录可能被 dotfiles 仓库或云盘同步。请不要把 `opendesign-local-routing-vault/` 纳入同步或提交。

## 报告安全问题

请**不要**在公开的 Issue 里贴漏洞细节、密钥、`.dpapi` 文件、`plugin-auth.json` 或 API 响应原文。

- 首选：使用 GitHub 的私密漏洞报告（仓库页 Security → Report a vulnerability）。该入口需要维护者在仓库设置中启用（Settings → Code security → Private vulnerability reporting），仓库公开后才对外可用。
- 在该入口可用之前：请通过 GitHub 联系维护者 yuki（用户名 Yuuuuuukit），只说明“有安全问题需要私下沟通”，不要在公开渠道写细节。
- 如果密钥可能已经泄露，请先在 OpenDesign 厂商侧轮换 Control Key 与 Runtime Key。

## 发布物

仓库与发布包只包含源码、文档和虚构的测试数据。`.gitignore` 无法保护已经进入 git 历史的秘密，发布前还须检查实际的文件清单，见 [维护者发布清单](PUBLISH.md)。

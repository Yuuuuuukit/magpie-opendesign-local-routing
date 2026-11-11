# 第三方许可证审查（2026-11-11 更新）

## 审核范围

| 对象 | 许可证据 | 本仓库的关系 | 处理 |
|---|---|---|---|
| `magpie-community/plugins/packages/opendesign` | `package.json` 标为 `MIT`，仓库根目录 `LICENSE` | 借鉴额度解析、模型目录和倍率表 | 保留上游版权和 MIT 许可；在 `NOTICE.md` 标注具体来源 |
| `yetone/magpie` | 根目录 `LICENSE` 为 MIT | 使用公开的插件接口和路由协议，没有复制 Magpie 主程序源码 | 说明兼容关系，声明非官方背书 |
| OpenDesign 官网与 API | 商标及服务条款不等同于软件 MIT | 使用官方 API 地址及产品名称 | 仅作兼容性描述；不嵌入或热链官方 Logo |

## 原始权利声明与使用条件

- 原社区插件：`Copyright (c) 2026 magpie-community contributors`。
- Magpie 主程序：`Copyright (c) 2026 yetone`。
- MIT 允许使用、复制、修改、合并、发布、分发、再许可和销售软件，条件是分发时保留相应的版权声明和许可全文。
- 本仓库的 `LICENSE` 同时包含原社区插件的版权声明、本仓库维护者（yuki）的版权声明和 MIT 全文；`NOTICE.md` 指明受参考的目录和数据文件。禁止把本版本标为“官方版”。
- 修改自己的插件，并不意味着能以 MIT 重新许可 OpenDesign 的商标、服务接口或付费额度。

## 发布前核查

- 仓库没有嵌入 OpenDesign 官方 Logo，仅在描述中使用兼容性名称。
- `.gitignore` 排除 `opendesign-local-routing-vault/`、`.opendesign-local-routing-vault/`、`*.dpapi`、`plugin-auth.json`、`.env*` 等，但无法保护已经进入 git 历史的内容；公开发布前须检查完整历史。
- 发布包不得包含真实的 Control Key、Runtime Key、Workspace 凭据、Windows DPAPI 密文或用户资料。
- 模拟测试不能证明真实的 Magpie / OpenDesign 环境已通过验收，状态以 [验收状态](VERIFICATION.md) 为准。

## 官方证据

- https://github.com/magpie-community/plugins/blob/main/LICENSE
- https://github.com/magpie-community/plugins/blob/main/packages/opendesign/package.json
- https://github.com/magpie-community/plugins/tree/main/packages/opendesign
- https://github.com/yetone/magpie/blob/main/LICENSE

本审查是工程层面的许可证核查，不是正式的法律意见。公开发布前如需商标、商用授权方面的法律结论，请咨询专业人士。

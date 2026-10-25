# 第三方资源与许可证

仓库原有的 Apache-2.0 `LICENSE` 适用于本项目原创代码；不会替第三方软件、游戏素材或用户提供的参考资料授予新许可。

- `public/minecraft/`、`public/data/entities.json` 等 Minecraft 模型、纹理、译名及提取数据来自本机 Java 1.21.1 安装，相关权利归 Mojang / Microsoft。本项目不是 Minecraft 官方产品。目录中不包含 Minecraft 客户端可执行程序、游戏账户或存档。
- `references/` 为用户提供的 MARD 色卡和立体拼豆样例；保留原始文件。H01 为透明豆的语义由用户补充，H02 用于白色。参考资料的权利仍归原作者。
- `public/vendor/` 使用 Three.js 0.180.0（MIT）；许可证随库保存。完整开发依赖及各自许可证位于 `vendor/node/`，来源、版本与校验记录见 `vendor/dependencies.json`。
- `runtime/` 包含 Node.js 官方 Windows x64、macOS Apple Silicon 和 Intel 发行包，原包内保留 Node.js 及其内含组件的许可证。来源与 SHA-256 见 `runtime/manifest.json`、官方 `SHASUMS256.txt`，并保留一份 `runtime/LICENSE.node` 便于查阅。

运行网站不需要完整 Minecraft 安装。`scripts/import-minecraft.py`、实体重导入工具中记录的旧游戏/JDK/Gradle 路径仅用于重新提取素材；它们不是网站或已导入模型的运行依赖。

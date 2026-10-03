# 句。间 Between

*Words into worlds.*

在感兴趣的文章里学英语。用 Codex 寻找单词和真实英文文章，边读边问，让每次学习都有迹可循。

[快速开始](#快速开始) · [使用指南](docs/usage.md) · [模型与配置](docs/configuration.md)

![句。间阅读界面：左侧英文原文，右侧句子讲解与提问](docs/images/reading-preview.jpg)

*阅读界面预览，文章与讲解均为示例内容。*

## 一点积累，自成语感

| 从这里开始 | 可以做什么 |
| --- | --- |
| **选材** | 写下想学的方向，按数量、参考难度和主题筛选单词与文章，分别送入词表和书架。 |
| **单词** | 卡片、拼写与间隔复习；收藏生词，搜索词表，循序巩固。 |
| **阅读** | 左侧读原文，右侧结合全文和选中句子讲解；翻译、提问、理解测试与批改。也可导入自己的文章。 |
| **积累** | 用 Daily / Weekly 学习足迹回看进度，让学习记忆帮助推荐下次的方向。 |

在「设置」中获取可用模型，分别调整检索与阅读助手的 Effort / Fast。阅读助手也支持自定义 OpenAI 兼容 API。

## 快速开始

需要 **Node.js 22.13+（推荐 24）** 和 npm。

```sh
git clone https://github.com/wqq977wqq977-source/between-english.git
cd between-english
npm ci
npm start
```

打开 [http://127.0.0.1:4318](http://127.0.0.1:4318)。终端按 `Ctrl+C` 停止服务。

**开始检索：** 安装 Codex CLI 后，在另一个终端运行 `codex login`，再到「设置」获取模型。网页可先启动；单词和文章检索需要已登录的 Codex。自定义 API 仅用于阅读助手，配置方式见[自定义 API](docs/configuration.md#自定义-api)。

**macOS：** 也可双击 [`start.command`](start.command)，在后台启动服务并打开网页。更多方式见[启动说明](docs/configuration.md#启动方式)。

## 你的学习空间

- 单词、文章与进度保存在本机 SQLite；学习备注和摘要保存在 `memroy.md`，首次启动自动创建。
- 学习记录和个性化默认开启，可在设置中分别关闭。模型请求会发送任务需要的原文、问题，以及个性化开启时所需的记忆摘要。
- 检索使用当前 Codex 账户额度；自定义 API 使用对应供应商额度。服务仅监听本机地址，面向个人使用。

默认数据目录、记忆、密钥和日志已排除在 Git 提交之外。数据位置、备份和调用边界见[配置说明](docs/configuration.md)。

## 开发

原生 JavaScript / CSS，Node HTTP / SQLite，无需前端构建。文章提取使用 Readability 与 LinkeDOM。

```sh
npm run dev    # 后端修改后自动重启
npm run check
npm test
```

测试使用临时数据与替身服务，不需要模型账户。

[开发约定](CONTRIBUTING.md) · [数据保护与问题报告](SECURITY.md)

本仓库暂未授予开源许可，标记为 `UNLICENSED`。

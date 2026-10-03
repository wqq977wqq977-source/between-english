# 句。间 Between

*Words into worlds.*

一个本地运行的英语学习空间。通过 Codex CLI 寻找单词和真实英文文章，在阅读、提问与复习中积累自己的学习记录。

## 快速开始

需要 **Node.js 22.13+（推荐 24）**、npm，以及已安装并登录的 Codex CLI。单词和文章检索使用 Codex；阅读助手也可接入自定义 API。

首次获取并启动：

```sh
git clone https://github.com/wqq977wqq977-source/between-english.git
cd between-english
npm ci
codex login
npm start
```

打开 [句。间](http://127.0.0.1:4318)。已有本地项目或已登录 Codex 时可跳过对应步骤；终端按 `Ctrl+C` 停止服务。首次使用可在「设置」中获取可用模型。尚未配置 Codex 时，网页仍可启动。

macOS 也可双击仓库中的 [`start.command`](start.command)，自动启动后台服务并打开网页。桌面 `.app` 不包含在仓库中。其他启动方式见[配置说明](docs/configuration.md#启动方式)。

## 可以做什么

| 页面 | 功能 |
| --- | --- |
| 选材中心 | 输入学习方向，一次筛选单词和文章，分发到词表与阅读书架；根据学习记忆推荐方向。 |
| 单词 | 按数量、难度与主题选词；搜索和分页浏览词表；卡片、拼写、生词收藏与间隔复习。 |
| 阅读 | 筛选真实英文文章或导入正文；划句提问、全文翻译、理解题与批改，助手结合文章上下文回答。 |
| 我的学习 | Daily / Weekly 学习足迹、连续学习天数与最近内容；单词按周期内学过的不同词数统计。 |
| 设置 | 获取可用模型，分别配置检索与阅读助手的 Effort / Fast；管理自定义 API 和个人学习记忆。 |

## 数据与模型

学习内容保存在本机 SQLite，个人学习记忆写入 `memroy.md`，首次启动自动创建。数据库、个人记忆、密钥、运行日志和临时文件均排除在 Git 提交之外。

模型请求需要联网：检索使用当前 Codex 登录账户；阅读助手使用所选 Codex 或 API。相关原文、问题，以及开启个性化后的记忆摘要会随请求发送。服务仅监听本机地址，适合个人使用。

详见[使用指南](docs/usage.md)与[配置、数据和调用边界](docs/configuration.md)。

## 开发与验证

```sh
npm run dev   # 修改后自动重启后端
npm run check
npm test
```

前端使用原生 JavaScript / CSS，无需构建；后端使用 Node HTTP / SQLite，文章提取使用 Readability 和 LinkeDOM。测试使用临时数据与替身服务，不需要模型账户。

```text
public/          页面、样式与交互
server/          本地 API、模型调用、选材、记忆与数据存储
scripts/         启动器
test/            自动化测试
docs/            使用与配置文档
start.command    macOS 一键启动
```

开发约定与提交检查见 [CONTRIBUTING.md](CONTRIBUTING.md)，数据保护与问题报告见 [SECURITY.md](SECURITY.md)。GitHub Actions 在 Node.js 22 / 24 上执行检查。

本仓库暂未授予开源许可，包标记为 `UNLICENSED`。
